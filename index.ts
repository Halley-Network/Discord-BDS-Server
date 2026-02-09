import { ApplicationCommandOptionType, Client, GuildMemberRoleManager, IntentsBitField, TextChannel } from 'discord.js';
import { default as express } from 'express';
import { default as bodyParser } from "body-parser";
import { spawn, ChildProcessWithoutNullStreams, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import EventEmitter from 'events';
import cors from 'cors';
import * as config from './config.json';
import { promisify } from 'util'

const execAsync = promisify(exec);
const STATE_FILE = './active_servers.json';
const client = new Client({ 
    intents: [
        IntentsBitField.Flags.Guilds, 
        IntentsBitField.Flags.GuildMessages, 
        IntentsBitField.Flags.MessageContent
    ] 
});

const app = express();
app.use(bodyParser.json());
app.use(cors());

const activeProcesses: { [port: string]: ChildProcessWithoutNullStreams } = {};
const detectedServers: { [port: string]: { path: string, cwd: string, channelId: string } } = {};
const messageQueues: { [port: string]: any[] } = {};
const idEvent = new EventEmitter();

// --- 状態保存ロジック ---

function saveState() {
    const state: { [port: string]: number } = {};
    for (const port in activeProcesses) {
        state[port] = activeProcesses[port].pid!;
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function checkOrphanedProcesses() {
    if (!fs.existsSync(STATE_FILE)) return;
    try {
        const savedState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        console.log("🔍 前回の状態を確認中...");
        for (const port in savedState) {
            const pid = savedState[port];
            try {
                process.kill(pid, 0); 
                console.warn(`⚠️ 警告: Port ${port} (PID: ${pid}) はまだ動いている可能性があります。`);
            } catch (e) {}
        }
    } catch (e) {
        console.error("状態ファイルの読み込みに失敗しました。");
    }
}

// --- ユーティリティ ---

function getQueue(port: string) {
    if (!messageQueues[port]) messageQueues[port] = [];
    return messageQueues[port];
}

function sendToConsole(port: string, command: string): boolean {
    const proc = activeProcesses[port];
    if (proc && proc.stdin.writable) {
        proc.stdin.write(command + "\n");
        return true;
    }
    return false;
}

function discoverServers() {
    console.log("🔍 サーバーフォルダを検索中...");
    const currentDir = path.join(process.cwd(), "..");
    const items = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const item of items) {
        if (item.isDirectory() && /^\d+/.test(item.name)) {
            const port = item.name.match(/^\d+/)![0];
            const folderPath = path.join(currentDir, item.name);
            const exePath = path.join(folderPath, "bedrock_server.exe");
            const binPath = path.join(folderPath, "bedrock_server");
            const finalPath = fs.existsSync(exePath) ? exePath : (fs.existsSync(binPath) ? binPath : null);

            if (finalPath) {
                const mapping = (config.servers as any)[port];
                detectedServers[port] = {
                    path: finalPath,
                    cwd: folderPath,
                    channelId: mapping?.channelId || config.logChannelId
                };
                console.log(`✅ 発見: Port ${port} -> ${finalPath}`);
            }
        }
    }
}

function generateStatusEmbed() {
    const list = Object.keys(detectedServers).map(p => {
        const active = activeProcesses[p] !== undefined;
        return `**Port ${p}**: ${active ? "🟢 起動中" : "🔴 停止中"} ${active ? `(PID: \`${activeProcesses[p].pid}\`)` : ""}`;
    });

    return {
        title: "📊 サーバーリアルタイム稼働状況",
        description: list.join("\n") || "サーバーが検出されていません。",
        color: 0x5865F2,
        footer: { text: `最終更新: ${new Date().toLocaleString("ja-JP")}` }
    };
}

// --- Git Pull を実行する内部関数 ---
async function runGitPull(port: string): Promise<string> {
    const server = detectedServers[port];
    if (!server) return `Port ${port}: サーバーが見つかりません。`;

    const targets = config.system.gitpull_target;
    let results = `**[Port ${port} Git Pull]**\n`;

    for (const folder of targets) {
        const targetPath = path.join(server.cwd, "behavior_packs", folder);
        
        if (!fs.existsSync(targetPath)) {
            results += `❓ ${folder}: フォルダが存在しません。\n`;
            continue;
        }

        try {
            // 指定ディレクトリへ移動して git pull を実行
            const { stdout, stderr } = await execAsync('git pull', { cwd: targetPath });
            results += `✅ ${folder}: \`${stdout.trim() || "Already up to date."}\`\n`;
        } catch (error: any) {
            results += `❌ ${folder}: エラー発生\n\`\`\`${error.message}\`\`\`\n`;
        }
    }
    return results;
}

async function sendSplitMessage(interaction: any, title: string, text: string) {
    // Discordの制限2000文字に対し、装飾分を含めて1900文字で分割
    const chunks = text.match(/[\s\S]{1,1900}/g) || [];
    
    for (let i = 0; i < chunks.length; i++) {
        const isFirst = i === 0;
        const header = isFirst ? `**${title}**\n` : "";
        const content = `${header}\`\`\`\n${chunks[i]}\n\`\`\``;

        if (isFirst) {
            await interaction.editReply(content);
        } else {
            await interaction.followUp(content);
        }
    }
}

// --- サーバー起動処理の共通化 ---
function startServer(port: string) {
    const server = detectedServers[port];
    if (!server || activeProcesses[port]) return;

    const child = spawn(server.path, [], { cwd: server.cwd });
    activeProcesses[port] = child;
    saveState();

    const chatChannel = client.channels.cache.get(server.channelId) as TextChannel;
    const logChannel = client.channels.cache.get(config.logChannelId) as TextChannel;

    if (chatChannel) {
        chatChannel.send({
            embeds: [{
                title: "Server Status",
                description: `🚀 **Port:${port}** が自動再起動しました。`,
                color: 0x00ff00
            }]
        }).catch(() => {});
    }

    child.stdout.on('data', (data) => {
        if (logChannel) {
            logChannel.send(`\`${new Date().toLocaleString("ja-JP")}\` [**${port}**] \`\`\`\n${data.toString().trim()}\n\`\`\``).catch(() => {});
        }
    });

    child.on('close', (code) => {
        delete activeProcesses[port];
        saveState();
        if (chatChannel) {
            chatChannel.send({
                embeds: [{
                    title: "Server Status",
                    description: `🛑 **Port:${port}** が停止しました。`,
                    color: 0xff0000
                }]
            }).catch(() => {});
        }
    });
}

// --- Discord ボット処理 ---
client.on('ready', async () => {
    discoverServers();
    checkOrphanedProcesses();
    console.log(`🚀 Manager logged in as ${client.user!.tag}`);
    
    // コマンド登録：2つのグループを作成
    await client.application!.commands.set([
        {
            name: "admin",
            description: "BDSマネージャー操作",
            options: [
                // グループ1: サーバー操作 (start, stop, eval)
                {
                    type: ApplicationCommandOptionType.SubcommandGroup,
                    name: "server",
                    description: "特定のサーバーに対する操作",
                    options: [
                        {
                            type: ApplicationCommandOptionType.Subcommand,
                            name: "start",
                            description: "指定したポートのサーバーを起動",
                            options: [{ type: ApplicationCommandOptionType.String, name: "port", description: "ポート番号", required: true }]
                        },
                        {
                            type: ApplicationCommandOptionType.Subcommand,
                            name: "stop",
                            description: "指定したポートのサーバーを停止",
                            options: [{ type: ApplicationCommandOptionType.String, name: "port", description: "ポート番号", required: true }]
                        },
                        {
                            type: ApplicationCommandOptionType.Subcommand,
                            name: "eval",
                            description: "コンソールコマンドを実行",
                            options: [
                                { type: ApplicationCommandOptionType.String, name: "port", description: "ポート番号", required: true },
                                { type: ApplicationCommandOptionType.String, name: "command", description: "実行内容", required: true }
                            ]
                        },
                        { 
                            name: "pull", 
                            type: ApplicationCommandOptionType.Subcommand,
                            description: "behavior_packs内のGit Pullを実行",
                            options: [{ type: ApplicationCommandOptionType.String, name: "port", required: true, description: "ポート番号" }]
                        }
                    ]
                },
                // グループ2: システム操作 (scan, status, monitor)
                {
                    type: ApplicationCommandOptionType.SubcommandGroup,
                    name: "system",
                    description: "システム全体に関する操作",
                    options: [
                        {
                            type: ApplicationCommandOptionType.Subcommand,
                            name: "scan",
                            description: "フォルダ構成を再スキャン"
                        },
                        {
                            type: ApplicationCommandOptionType.Subcommand,
                            name: "status",
                            description: "現在の稼働状況を表示 (一回のみ)"
                        },
                        {
                            type: ApplicationCommandOptionType.Subcommand,
                            name: "monitor",
                            description: "稼働状況をリアルタイム監視 (旧 status-live)"
                        },
                        {
                            name: "pull-all",
                            type: ApplicationCommandOptionType.Subcommand,
                            description: "全サーバーのbehavior_packsを一括Git Pull"
                        },
                        {
                            name: "update-bds",
                            type: ApplicationCommandOptionType.Subcommand,
                            description: "Minecraft BDS本体をアップデート"
                        }

                    ]
                }
            ]
        }
    ], config.guildId);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "admin") return;

    const roleId = config.commands.opCommands.roleId;
    if (!(interaction.member?.roles as GuildMemberRoleManager).cache.has(roleId)) {
        return interaction.reply({ content: "実行権限がありません。", ephemeral: true });
    }

    // グループとサブコマンドを取得
    const group = interaction.options.getSubcommandGroup();
    const subcommand = interaction.options.getSubcommand();

    // --- System グループの処理 ---
    if (group === "system") {
        if (group === "system") {
            if (subcommand === "update-bds") {
                await interaction.deferReply();

                const rootDir = path.join(process.cwd(), "..");
                const updaterPath = path.join(rootDir, "BDS-Updater", "src", "DownloadBDS.js");
                const logFileName = `update_log_${Date.now()}.txt`;

                if (!fs.existsSync(updaterPath)) {
                    return interaction.editReply(`❌ アップデーターが見つかりません。`);
                }

                // 1. 現在起動しているサーバーを記録
                const runningPorts = Object.keys(activeProcesses);
                
                if (runningPorts.length > 0) {
                    await interaction.editReply(`⏳ 稼働中のサーバー (${runningPorts.join(", ")}) を停止してからアップデートを開始します...`);

                    // 全てのサーバーが閉じるのを待機するPromise配列
                    const stopPromises = runningPorts.map(port => {
                        return new Promise<void>((resolve) => {
                            const proc = activeProcesses[port];
                            if (proc) {
                                proc.once('close', () => resolve());
                                sendToConsole(port, "stop"); // 停止命令
                            } else {
                                resolve();
                            }
                        });
                    });

                    await Promise.all(stopPromises);
                    await interaction.editReply(`✅ 全サーバーの停止を確認。アップデートを実行中...`);
                }

                // 2. アップデート実行 (spawnによるストリーム方式)
                try {
                    const logStream = fs.createWriteStream(logFileName);
                    let fullOutput = "";
                    const updaterProcess = spawn('node', [updaterPath]);

                    updaterProcess.stdout.on('data', (data) => {
                        logStream.write(data);
                        fullOutput += data.toString();
                    });

                    updaterProcess.stderr.on('data', (data) => {
                        logStream.write(`[ERR] ${data}`);
                    });

                    updaterProcess.on('close', async (code) => {
                        logStream.end();

                        const isSuccess = fullOutput.includes("All tasks completed!");
                        
                        // 3. 元々動いていたサーバーのみ再起動
                        if (isSuccess && code === 0) {
                            await interaction.followUp(`✅ アップデート成功。元々稼働していたサーバー (${runningPorts.join(", ") || "なし"}) を再起動します。`);
                            for (const port of runningPorts) {
                                startServer(port);
                            }
                        }

                        await interaction.editReply({
                            content: `📦 **アップデート処理終了** (Code: ${code})\n結果はログファイルを確認してください。`,
                            files: [logFileName]
                        });

                        if (fs.existsSync(logFileName)) fs.unlinkSync(logFileName);
                    });

                } catch (error: any) {
                    await interaction.editReply(`❌ 致命的なエラー: ${error.message}`);
                }
                return;
            }
        }

        if (subcommand === "scan") {
            discoverServers();
            return interaction.reply(`再スキャン完了: ${Object.keys(detectedServers).length} 個のサーバーを検出しました。`);
        }

        if (subcommand === "status") {
            return interaction.reply({ embeds: [generateStatusEmbed()] });
        }

        if (subcommand === "monitor") {
            await interaction.reply({ 
                embeds: [generateStatusEmbed()], 
                withResponse: true // 非推奨警告回避
            });

            const interval = setInterval(async () => {
                try {
                    await interaction.editReply({ embeds: [generateStatusEmbed()] });
                } catch (error) {
                    clearInterval(interval);
                }
            }, 10000);
            return;
        }

        if (subcommand === "pull-all") {
            await interaction.deferReply();
            const ports = Object.keys(detectedServers);
            let finalMsg = "📢 **全サーバー一括更新を開始します...**\n\n";

            for (const port of ports) {
                const res = await runGitPull(port);
                finalMsg += res + "\n";
            }

            return interaction.editReply({ content: finalMsg });
        }
    }

    // --- Server グループの処理 ---
    if (group === "server") {
        const port = interaction.options.getString("port", true);
        const server = detectedServers[port];

        if (!server) {
            return interaction.reply({ content: `ポート ${port} のサーバーが見つかりません。`, ephemeral: true });
        }

        if (subcommand === "start") {
            if (activeProcesses[port]) return interaction.reply("既に起動しています。");

            const child = spawn(server.path, [], { cwd: server.cwd });
            activeProcesses[port] = child;
            saveState();

            // チャットチャンネルへの通知
            const chatChannel = client.channels.cache.get(server.channelId) as TextChannel;
            if (chatChannel) {
                chatChannel.send({
                    embeds: [{
                        title: "Server Status",
                        description: `🚀 **Port:${port}** が起動しました。`,
                        color: 0x00ff00
                    }]
                }).catch(e => console.error("Start msg failed", e));
            }

            // ログチャンネルへの転送
            child.stdout.on('data', (data) => {
                const logChannel = client.channels.cache.get(config.logChannelId) as TextChannel;
                if (logChannel) {
                    logChannel.send(`\`${new Date().toLocaleString("ja-JP")}\` [**${port}**] \`\`\`\n${data.toString().trim()}\n\`\`\``).catch(()=>{});
                }
            });

            child.on('close', (code) => {
                delete activeProcesses[port];
                saveState();
                if (chatChannel) {
                    chatChannel.send({
                        embeds: [{
                            title: "Server Status",
                            description: `🛑 **Port:${port}** が停止しました。(Code: ${code})`,
                            color: 0xff0000
                        }]
                    }).catch(e => console.error("Stop msg failed", e));
                }
            });

            return interaction.reply(`サーバー ${port} を起動しました。`);
        }

        if (subcommand === "stop") {
            if (!activeProcesses[port]) return interaction.reply("サーバーが起動していません。");
            
            sendToConsole(port, "say §e[Discord] 管理者によりサーバーの停止が要請されました。");
            sendToConsole(port, "say §e[Discord] 5秒後にシャットダウンします。");
            
            setTimeout(() => sendToConsole(port, "stop"), 5000);
            return interaction.reply(`サーバー ${port} に停止命令を送信しました。`);
        }

        if (subcommand === "eval") {
            const command = interaction.options.getString("command", true);
            const success = sendToConsole(port, command);
            
            if (success) {
                return interaction.reply(`[Port:${port}] 送信: \`${command}\``);
            } else {
                return interaction.reply({ content: "サーバーが起動していないため、送信できませんでした。", ephemeral: true });
            }
        }

        if (subcommand === "pull") {
            await interaction.deferReply();
            const res = await runGitPull(port);
            return interaction.editReply({ content: res });
        }
    }
});

// --- 以下、APIエンドポイント等は変更なし ---

// 通常のメッセージ転送 (Discord -> Minecraft)
client.on('messageCreate', (message) => {
    if (message.author.bot) return;
    for (const port in detectedServers) {
        if (detectedServers[port].channelId === message.channel.id) {
            getQueue(port).push({
                type: "message",
                author: message.author.displayName,
                content: message.content
            });
        }
    }
});

app.get('/:port/messages', (req, res) => {
    const port = req.params.port;
    const queue = getQueue(port);
    const resArray = [...queue];
    queue.length = 0;
    res.json(resArray);
});

app.post('/:port/eval', (req, res) => {
    const { id, status } = req.body;
    idEvent.emit(id, { status });
    res.sendStatus(200);
});

app.post('/:port/list', (req, res) => {
    const { id, players, max } = req.body;
    idEvent.emit(id, { players, max });
    res.sendStatus(200);
});

app.post('/:port/send', (req, res) => {
    const port = req.params.port;
    const { author, content } = req.body;
    const server = detectedServers[port];
    if (server) {
        (client.channels.cache.get(server.channelId) as TextChannel).send({
            embeds: [{ title: author, description: content, color: 0x0000ff }]
        });
    }
    res.sendStatus(200);
});

app.post('/:port/join', (req, res) => {
    const port = req.params.port;
    const { player } = req.body;
    const server = detectedServers[port];
    if (server) {
        (client.channels.cache.get(server.channelId) as TextChannel).send({
            embeds: [{ title: "Join", description: `**${player}** が参加しました。`, color: 0x00ff00 }]
        });
    }
    res.sendStatus(200);
});

app.post('/:port/leave', (req, res) => {
    const port = req.params.port;
    const { player } = req.body;
    const server = detectedServers[port];
    if (server) {
        (client.channels.cache.get(server.channelId) as TextChannel).send({
            embeds: [{ title: "Leave", description: `**${player}** が退出しました。`, color: 0xff0000 }]
        });
    }
    res.sendStatus(200);
});

app.listen(9000, () => {
    console.log("Manager API is running on port 9000");
});

client.login(config.discordToken);