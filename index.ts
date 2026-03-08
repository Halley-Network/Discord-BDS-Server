import { ApplicationCommandOptionType, Client, GuildMemberRoleManager, IntentsBitField, TextChannel, Events } from 'discord.js';
import { default as express } from 'express';
import { default as bodyParser } from "body-parser";
import { spawn, ChildProcessWithoutNullStreams, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import EventEmitter from 'events';
import cors from 'cors';
import * as config from './config.json';
import { promisify } from 'util';
import mongoose from 'mongoose';

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

// --- 外部公開用スキーマ ---
const publicStatusSchema = new mongoose.Schema({
    port: { type: String, required: true, unique: true },
    status: { type: String, enum: ['online', 'offline'], required: true },
    playerCount: { type: Number, default: 0 }, // 現在の人数のみ保持
    lastUpdate: { type: String, required: true }
});
const PublicStatus = mongoose.model('PublicStatus', publicStatusSchema, 'RealTimeStatus');

// 現在の人数だけを保持するメモリ変数
const serverStats: { [port: string]: number } = {};

// Mongoose 接続とループ開始
async function connectPublicDB() {
        try {
        // serverSelectionTimeoutMS を入れておくと、失敗時にすぐわかります
        
        await mongoose.connect(config.mongoUri, {
            family: 4,
            serverSelectionTimeoutMS: 10000,
            tlsAllowInvalidCertificates: true,
        });
        //await mongoose.connect(config.mongoUri, mongoose_client);
        console.log("🍃 Public Database connected to 'ServerStatus' via Mongoose");
        
        // 初回起動時にも一度同期を実行
        updatePublicStatus();
        setInterval(updatePublicStatus, 10000);
    } catch (err) {
        console.error("❌ MongoDB connection error:", err);
    }
}

async function updatePublicStatus() {
    const now = new Date();
    const timestamp = `${now.getFullYear()}/${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getDate().toString().padStart(2, '0')} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

    for (const port in detectedServers) {
        const isActive = activeProcesses[port] !== undefined;
        
        // サーバーが停止している場合のみ、人数を 0 にリセットして更新
        if (!isActive) {
            try {
                await PublicStatus.findOneAndUpdate(
                    { port: port },
                    {
                        status: 'offline',
                        playerCount: 0,
                        lastUpdate: timestamp
                    },
                    { upsert: true }
                );
                serverStats[port] = 0; // メモリもリセット
            } catch (err) {
                console.error(`❌ DB Sync Error (Offline) [Port ${port}]:`, err);
            }
        }
        // 起動中の場合は API (/:port/list) 側が更新を行うため、ここでは何もしない（上書き防止）
    }
}

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

// バックアップを実行し、前回との差分も計算する
async function runBackup(port: string, serverCwd: string) {
    const managerDir = path.resolve(__dirname);
    const backupBaseDir = path.join(managerDir, "..", "_backups");
    const portBackupDir = path.join(backupBaseDir, port);
    const tempStageDir = path.join(backupBaseDir, "temp_stage", port);

    if (!fs.existsSync(portBackupDir)) fs.mkdirSync(portBackupDir, { recursive: true });

    // --- 差分計算のための準備 ---
    // 既存のバックアップファイルを取得して日付順にソート
    const existingFiles = fs.readdirSync(portBackupDir)
        .filter(f => f.endsWith('.zip'))
        .map(f => ({ name: f, time: fs.statSync(path.join(portBackupDir, f)).mtime.getTime() }))
        .sort((a, b) => b.time - a.time);

    const prevBackup = existingFiles[0]; // 最新のファイルが「前回のバックアップ」
    let prevSize = 0;
    if (prevBackup) {
        prevSize = fs.statSync(path.join(portBackupDir, prevBackup.name)).size;
    }

    // --- 圧縮処理 (前回の Robocopy 方式) ---
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `world_backup_${timestamp}.zip`;
    const destPath = path.join(portBackupDir, fileName);
    const worldPath = path.join(serverCwd, "worlds");

    try {
        if (fs.existsSync(tempStageDir)) fs.rmSync(tempStageDir, { recursive: true, force: true });
        
        // Robocopy で一時コピー
        const copyCommand = `robocopy "${worldPath}" "${tempStageDir}" /S /E /COPY:DAT /R:0 /W:0 /NP /NFL /NDL`;
        try { await execAsync(copyCommand); } catch (e: any) { if (e.code > 7) throw e; }

        // 圧縮
        const zipCommand = `powershell -Command "Compress-Archive -Path '${tempStageDir}\\*' -DestinationPath '${destPath}' -Force"`;
        await execAsync(zipCommand);
    } finally {
        if (fs.existsSync(tempStageDir)) fs.rmSync(tempStageDir, { recursive: true, force: true });
    }

    // --- 結果の集計 ---
    const newSize = fs.statSync(destPath).size;
    const delta = newSize - prevSize;
    const formatSize = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2) + " MB";

    return {
        fileName,
        size: formatSize(newSize),
        delta: (delta >= 0 ? "+" : "") + formatSize(delta),
        isFirst: prevSize === 0
    };
}

// --- スレッドIDを保持する変数を追加 ---
const activeThreads: { [port: string]: string } = {};

// --- サーバー起動処理の共通化 ---
async function startServer(port: string) {
    const server = detectedServers[port];
    if (!server || activeProcesses[port]) return;

    const logChannel = client.channels.cache.get(config.logChannelId) as TextChannel;
    if (!logChannel) return console.error("❌ ログチャンネルが見つかりません。");

    // 1. 命名規則に基づいたスレッドの作成 (ポート番号_スタート時間)
    const now = new Date();
    const startTimeStr = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}`;
    const threadName = `${port}_${startTimeStr}`;

    const thread = await logChannel.threads.create({
        name: threadName,
        autoArchiveDuration: 1440, // 24時間でアーカイブ
        reason: `BDS Port ${port} ログ用`
    });

    activeThreads[port] = thread.id;

    // 2. プロセスの起動
    const child = spawn(server.path, [], { cwd: server.cwd });
    activeProcesses[port] = child;
    saveState();

    const chatChannel = client.channels.cache.get(server.channelId) as TextChannel;

    // --- 起動通知 ---
    if (chatChannel) {
        chatChannel.send({
            embeds: [{ title: "Server Status", description: `🚀 **Port:${port}** が起動しました。`, color: 0x00ff00 }]
        }).catch(() => {});
    }

    let lineBuffer = "";

    child.stdout.on('data', async (data) => {
        lineBuffer += data.toString();
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() || "";

        for (const line of lines) {
            const cleanLine = line.trim();
            if (!cleanLine) continue;

            // 3. ログをスレッドに送信
            try {
                // キャッシュまたはフェッチでスレッドを取得
                const logThread = await client.channels.fetch(activeThreads[port]) as any;
                if (logThread) {
                    await logThread.send(`\`${new Date().toLocaleTimeString()}\` \`\`\`\n${cleanLine}\n\`\`\``);
                }
            } catch (e) {
                // スレッド送信失敗時はメインのログチャンネルに流す
                logChannel.send(`[${port}] ${cleanLine}`).catch(() => {});
            }
            
            // 2. 参加・退出の検知 (デバッグログ付き)
            if (chatChannel) {
                // BDSのログにはタイムスタンプ等が含まれるため、includes か test が確実です
                // 参加検知: "Player connected: 名前, xuid: ..."
                if (cleanLine.includes("Player connected:")) {
                    console.log(`[DEBUG] Join detected: ${cleanLine}`); // Node.js側に表示
                    const name = cleanLine.match(/Player connected: ([^,]+)/)?.[1];
                    if (name) {
                        chatChannel.send({
                            embeds: [{
                                title: "Join",
                                description: `**${name}** が参加しました。`,
                                color: 0x00ff00
                            }]
                        }).catch(() => {});
                    }
                }

                // 退出検知: "Player disconnected: 名前, xuid: ..."
                if (cleanLine.includes("Player disconnected:")) {
                    console.log(`[DEBUG] Leave detected: ${cleanLine}`); // Node.js側に表示
                    const name = cleanLine.match(/Player disconnected: ([^,]+)/)?.[1];
                    if (name) {
                        chatChannel.send({
                            embeds: [{
                                title: "Leave",
                                description: `**${name}** が退出しました。`,
                                color: 0xff0000
                            }]
                        }).catch(() => {});
                    }
                }
            }
        }
    });

    child.on('close', (code) => {
        delete activeProcesses[port];
        delete activeThreads[port]; // 終了時に削除
        saveState();
        
        if (thread) {
            thread.send(`🛑 サーバーが停止しました。 (Code: ${code})`).then(() => {
                thread.setArchived(true); // スレッドをアーカイブ
            });
        }
    });
}

client.once(Events.ClientReady, async (readyClient) => {
    discoverServers();
    checkOrphanedProcesses();
    
    // 公開用データベースに接続
    await connectPublicDB();
    
    console.log(`🚀 Manager connected to Discord & Public DB`);
});

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
                        },
                        {
                            name: "backup",
                            type: ApplicationCommandOptionType.Subcommand,
                            description: "ワールドデータのバックアップを作成",
                            options: [{ type: ApplicationCommandOptionType.String, name: "port", required: true, description: "ポート番号" }]
                        },
                        {
                            name: "backup-list",
                            type: ApplicationCommandOptionType.Subcommand,
                            description: "保存済みのバックアップ一覧を表示",
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
                        },
                        {
                            name: "db-check",
                            type: ApplicationCommandOptionType.Subcommand,
                            description: "MongoDBの保存データを確認"
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


        if (subcommand === "db-check") {
            await interaction.deferReply();
            const connState = mongoose.connection.readyState;
            const states = ["切断", "接続済み", "接続中", "切断中"];

            try {
                if (connState !== 1) {
                    return interaction.editReply(`❌ DB未接続 (状態: ${states[connState]})`);
                }

                // 全データを取得
                const records = await PublicStatus.find({}).sort({ port: 1 });

                if (records.length === 0) {
                    return interaction.editReply(`📡 **DB接続**: ✅\n⚠️ まだデータが保存されていません。同期をお待ちください。`);
                }

                const recordList = records.map((doc: any) => {
                    return `**Port ${doc.port}**: ${doc.status === 'online' ? "🟢 online" : "🔴 offline"} (${doc.playerCount || 0}人)\n└ 更新: \`${doc.lastUpdate}\``;
                });

                await interaction.editReply({
                    embeds: [{
                        title: "📡 MongoDB 公開データ確認",
                        description: recordList.join("\n"),
                        color: 0x00ff00,
                        footer: { text: "Database: ServerStatus | Collection: RealTimeStatus" },
                        timestamp: new Date().toISOString()
                    }]
                });
            } catch (err: any) {
                await interaction.editReply(`❌ 通信エラー: \`\`\`${err.message}\`\`\``);
            }
            return;
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
            await interaction.reply({ content: `サーバー ${port} の起動処理を開始し、専用スレッドを作成しました。`, ephemeral: true });
            await startServer(port);
        }
        /*
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
        }*/

        if (subcommand === "stop") {
            if (!activeProcesses[port]) return interaction.reply("サーバーが起動していません。");
            
            sendToConsole(port, "say §e[Discord] An administrator has issued a command to stop the server.");
            sendToConsole(port, "say §e[Discord] The server will shut down in 5 seconds.");
            
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

        if (subcommand === "backup") {
            await interaction.deferReply();
            const server = detectedServers[port];

            if (!server) return interaction.editReply(`❌ ポート ${port} の設定が見つかりません。`);

            try {
                // 1. データをフラッシュして保持 (save hold)
                sendToConsole(port, "save hold");
                
                // ログに出力された時間を考慮し、書き出し完了を少し長めに待機
                await new Promise(resolve => setTimeout(resolve, 5000)); 

                // 2. バックアップ実行 (Promiseが解決されるまでここで待機します)
                const result = await runBackup(port, server.cwd);
                sendToConsole(port, "save resume");

                const deltaInfo = result.isFirst ? " (初回バックアップ)" : ` (前回比: \`${result.delta}\`)`;
                await interaction.editReply(`✅ **バックアップ完了**\n- ファイル: \`${result.fileName}\`\n- サイズ: \`${result.size}\`${deltaInfo}`);
            } catch (err: any) {
                // エラーが起きてもサーバーを書き込み可能状態に戻す
                sendToConsole(port, "save resume"); 
                console.error(`Backup Error: ${err.message}`);
                await interaction.editReply(`❌ バックアップ失敗: ${err.message}`);
            }
            return;
        }

        if (subcommand === "backup-list") {
            await interaction.deferReply();
            const port = interaction.options.getString("port", true);
            const backupDir = path.join(process.cwd(), "..", "_backups", port);

            if (!fs.existsSync(backupDir)) {
                return interaction.editReply(`📂 ポート ${port} のバックアップはまだ作成されていません。`);
            }

            const files = fs.readdirSync(backupDir)
                .filter(f => f.endsWith('.zip'))
                .map(f => {
                    const stats = fs.statSync(path.join(backupDir, f));
                    return {
                        name: f,
                        size: (stats.size / (1024 * 1024)).toFixed(2) + " MB",
                        time: stats.mtime
                    };
                })
                .sort((a, b) => b.time.getTime() - a.time.getTime())
                .slice(0, 10); // 直近10件を表示

            if (files.length === 0) return interaction.editReply(`⚠️ バックアップファイルが見つかりません。`);

            const list = files.map((f, i) => `${i + 1}. \`${f.name}\` (${f.size})`).join("\n");

            await interaction.editReply({
                embeds: [{
                    title: `📂 Port ${port} バックアップ履歴 (最新10件)`,
                    description: list,
                    color: 0x5865F2,
                    timestamp: new Date().toISOString()
                }]
            });
            return;
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

// --- APIエンドポイント (/:port/list) のデバッグ強化版 ---
app.post('/:port/list', async (req, res) => {
    const port = req.params.port;
    const { players } = req.body;

    if (players === undefined) {
        return res.sendStatus(400);
    }

    const count = Number(players);
    serverStats[port] = count; // メモリを更新

    try {
        const now = new Date();
        const timestamp = `${now.getFullYear()}/${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getDate().toString().padStart(2, '0')} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

        // 10秒周期を待たずに、ここで即座にDBを更新
        // 人数が届いている＝動いているので status は 'online' 固定で更新
        await PublicStatus.findOneAndUpdate(
            { port: port },
            {
                status: 'online',
                playerCount: count,
                lastUpdate: timestamp
            },
            { upsert: true }
        );
    } catch (err) {
        console.error(`❌ DB Direct Update Error [Port ${port}]:`, err);
    }

    idEvent.emit(req.body.id, { players });
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
    /*
    if (server) {
        (client.channels.cache.get(server.channelId) as TextChannel).send({
            embeds: [{ title: "Join", description: `**${player}** が参加しました。`, color: 0x00ff00 }]
        });
    }
    res.sendStatus(200);*/
});

app.post('/:port/leave', (req, res) => {
    const port = req.params.port;
    const { player } = req.body;
    const server = detectedServers[port];
    /*
    if (server) {
        (client.channels.cache.get(server.channelId) as TextChannel).send({
            embeds: [{ title: "Leave", description: `**${player}** が退出しました。`, color: 0xff0000 }]
        });
    }
    res.sendStatus(200);*/
});

app.listen(9000, () => {
    console.log("Manager API is running on port 9000");
});

client.login(config.discordToken);