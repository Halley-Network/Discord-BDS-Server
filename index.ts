import {
    ApplicationCommandOptionType,
    Client,
    GuildMemberRoleManager,
    IntentsBitField,
    TextChannel,
    Events,
    ChatInputApplicationCommandData
} from 'discord.js';
import { default as express } from 'express';
import { default as bodyParser } from "body-parser";
import { spawn, ChildProcessWithoutNullStreams, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import EventEmitter from 'events';
import cors from 'cors';
import { promisify } from 'util';
import mongoose from 'mongoose';

// 物理ファイルを読み込み、変数に格納
let config = JSON.parse(fs.readFileSync(path.resolve(__dirname, './config.json'), 'utf-8'));

const execAsync = promisify(exec);
const STATE_FILE = './active_servers.json';
const client = new Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.MessageContent
    ]
});

// 実行中のモニター更新を管理する変数
let currentMonitorInterval: NodeJS.Timeout | null = null;

const app = express();
app.use(bodyParser.json());
app.use(cors());

// Discordに登録するコマンドリスト
const DiscordCommandData: ChatInputApplicationCommandData = {
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
                    description: "behavior_packs内のGit Pullを実行 及び tsc -dを実行",
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
                },
                {
                    type: ApplicationCommandOptionType.Subcommand,
                    name: "restart",
                    description: "サーバーを再起動",
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
                    description: "稼働状況をリアルタイム監視"
                },
                {
                    name: "pull-all",
                    type: ApplicationCommandOptionType.Subcommand,
                    description: "全サーバーのbehavior_packsを一括Git Pull 及び tsc -dを実行"
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
                },
                {
                    type: ApplicationCommandOptionType.Subcommand,
                    name: "restart-all",
                    description: "実行中の全サーバーを順次再起動"
                },
                {
                    name: "help",
                    type: ApplicationCommandOptionType.Subcommand,
                    description: "利用可能な全コマンドの一覧を表示"
                },
                {
                    name: "reload",
                    type: ApplicationCommandOptionType.Subcommand,
                    description: "設定ファイルを再読み込みし、コマンドを同期"
                }
            ]
        }
    ]
}

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

// 特定のポートのサーバーを再起動
async function restartServer(port: string) {
    if (activeProcesses[port]) {
        return new Promise<void>((resolve) => {
            // プロセスが閉じたら再起動を実行する
            activeProcesses[port].once('close', async () => {
                await startServer(port);
                resolve();
            });
            // サーバーに停止命令を送信
            sendToConsole(port, "stop");
        });
    } else {
        // 動いていない場合はそのまま起動
        await startServer(port);
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
        const threadId = activeThreads[p]; // 起動中のスレッドIDを取得
        
        // 起動中の場合のみ、スレッドへのリンクを表示
        const threadLink = (active && threadId) ? `\n　└ ログ: <#${threadId}>` : "";
        
        return `**Port ${p}**: ${active ? "🟢 起動中" : "🔴 停止中"}${threadLink}`;
    });

    return {
        title: "📊 サーバーリアルタイム稼働状況",
        description: list.join("\n") || "サーバーが検出されていません。",
        color: 0x5865F2,
        footer: { text: `最終更新: ${new Date().toLocaleString("ja-JP")}` }
    };
}

// --- Git Pull & コンパイルを実行する内部関数 ---
async function runGitPull(port: string): Promise<string> {
    const server = detectedServers[port];
    if (!server) return `Port ${port}: サーバーが見つかりません。`;

    const targets = config.system.gitpull_target; 
    let results = `**[Port ${port} Git Pull & Compilation]**\n`;

    for (const folder of targets) {
        const targetPath = path.join(server.cwd, "behavior_packs", folder);
        
        if (!fs.existsSync(targetPath)) {
            results += `❓ ${folder}: フォルダが存在しません。\n`;
            continue;
        }

        try {
            // 1. Git Pull を実行
            const { stdout: pullOut } = await execAsync('git pull', { cwd: targetPath });
            results += `✅ ${folder}: Pull \`${pullOut.trim() || "Already up to date."}\`\n`;

            // 2. config.ts の探索と書き換え
            const potentialPaths = [
                path.join(targetPath, "config.ts"),
                path.join(targetPath, "src", "config.ts"),
                path.join(targetPath, "scripts", "config.ts")
            ];

            let fileFound = false;
            for (const configFilePath of potentialPaths) {
                if (fs.existsSync(configFilePath)) {
                    fileFound = true;
                    const originalContent = fs.readFileSync(configFilePath, 'utf-8');
                    const updatedContent = originalContent.replace(
                        /(server_port\s*[:=]\s*)(["']?)\d*(["']?)/g, 
                        `$1$2${port}$3`
                    );

                    if (originalContent !== updatedContent) {
                        fs.writeFileSync(configFilePath, updatedContent, 'utf-8');
                        results += `   └ 📝 \`${path.relative(targetPath, configFilePath)}\` を \`${port}\` に更新\n`;
                    }
                }
            }
            if (!fileFound) results += `   ⚠️ config.ts 未検出 (スキップ)\n`;

            // 3. コンパイル処理の追加 ($ tsc -d)
            results += `   ⏳ コンパイル中 (\`tsc -d\`)...`;
            try {
                // 1. 依存関係のインストール（型定義ファイルを揃える）
                // 初回やリポジトリ更新時に必要です
                await execAsync('npm install', { cwd: targetPath });

                // 2. コンパイルの実行
                await execAsync('tsc -d', { cwd: targetPath });
                results += ` ✅ 成功\n`;
            } catch (e: any) {
                // エラー詳細を取得
                const detail = e.stdout || e.message;
                
                // JSファイルが生成されていれば「成功」とみなす
                // (scripts/index.js など、ビルド後のパスに合わせて調整してください)
                const jsPath = path.join(targetPath, "scripts", "index.js"); 
                if (fs.existsSync(jsPath)) {
                    results += ` ✅ 成功 (型エラー ${e.code} は無視されました)\n`;
                } else {
                    results += ` ❌ 失敗: \n\`\`\`\n${detail.substring(0, 300)}...\n\`\`\`\n`;
                }
            }

        } catch (error: any) {
            results += `❌ ${folder}: 重大なエラー発生\n\`\`\`${error.message}\`\`\`\n`;
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
        delete activeThreads[port];
        saveState();
        
        if (chatChannel) {
            chatChannel.send({
                embeds: [{
                    title: "Server Status",
                    description: `🛑 **Port:${port}** が完全に停止しました。(Code: ${code})\n※再起動の場合は、この後すぐに起動通知が流れます。`,
                    color: 0xff0000 // 赤色
                }]
            }).catch(() => {});
        }

        if (thread) {
            thread.send(`🛑 サーバーが停止しました。 (Code: ${code})`)
                .then(() => {
                    thread.setArchived(true).catch(() => {});
                })
                .catch(() => {});
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
    await client.application!.commands.set([DiscordCommandData], config.guildId);
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

        if (subcommand === "scan") {
            discoverServers();
            return interaction.reply(`再スキャン完了: ${Object.keys(detectedServers).length} 個のサーバーを検出しました。`);
        }

        if (subcommand === "status") {
            return interaction.reply({ embeds: [generateStatusEmbed()] });
        }

        if (subcommand === "monitor") {
            // 1. もし既に実行中のモニターがあれば停止させる（最新のみを動かすため）
            if (currentMonitorInterval) {
                clearInterval(currentMonitorInterval);
                currentMonitorInterval = null;
            }

            // 2. 初回応答
            await interaction.reply({ 
                embeds: [generateStatusEmbed()] 
            });

            // 3. 10秒ごとの自動更新を開始
            currentMonitorInterval = setInterval(async () => {
                try {
                    // 最新のメッセージ（現在の interaction）のみを更新
                    await interaction.editReply({ 
                        embeds: [generateStatusEmbed()] 
                    });
                } catch (error) {
                    // メッセージが削除されたり、エラーが起きた場合はタイマーを破棄
                    if (currentMonitorInterval) {
                        clearInterval(currentMonitorInterval);
                        currentMonitorInterval = null;
                    }
                }
            }, 10000); // 10秒間隔
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

        if (subcommand === "restart-all") {
            const runningPorts = Object.keys(activeProcesses);
            
            if (runningPorts.length === 0) {
                return interaction.reply({ content: "⚠️ 現在実行中のサーバーはありません。", ephemeral: true });
            }

            await interaction.reply({ content: `🔄 実行中の ${runningPorts.length} 個のサーバーを順次再起動します...`, ephemeral: true });

            for (const p of runningPorts) {
                await restartServer(p);
                // 負荷分散のため、次の再起動まで少し待機（任意）
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }

        if (subcommand === "help") {
            await interaction.deferReply({ ephemeral: true });

            try {
                // --- 1. システム構成情報の取得 ---
                const guildName = interaction.guild?.name || "不明なサーバー";
                const logChannel = `<#${config.logChannelId}>`;
                
                // 各サーバーのチャンネル設定
                const serverChannels = Object.entries(config.servers)
                    .map(([port, data]: [string, any]) => `・Port **${port}**: <#${data.channelId}>`)
                    .join("\n") || "未設定";

                // Gitリポジトリ名
                const gitRepos = config.system.gitpull_target
                    .map((repo: string) => `\`${repo}\``)
                    .join(", ") || "なし";

                // --- 2. コマンド一覧の生成 (スクリーンショット形式) ---
                const commands = await interaction.guild?.commands.fetch();
                let commandManual = "利用可能なコマンド一覧です：\n\n";

                if (commands && commands.size > 0) {
                    commands.forEach(cmd => {
                        commandManual += `**/${cmd.name}** - ${cmd.description}\n`;

                        if (cmd.options) {
                            cmd.options.forEach(opt => {
                                // SubcommandGroup (server, system など)
                                if (opt.type === ApplicationCommandOptionType.SubcommandGroup) {
                                    commandManual += `└ **${opt.name}** (Group)\n`;
                                    opt.options?.forEach(sub => {
                                        commandManual += `　└ \`/${cmd.name} ${opt.name} ${sub.name}\` - ${sub.description}\n`;
                                    });
                                } 
                                // Top-level Subcommand
                                else if (opt.type === ApplicationCommandOptionType.Subcommand) {
                                    commandManual += `└ \`/${cmd.name} ${opt.name}\` - ${opt.description}\n`;
                                }
                            });
                        }
                        commandManual += "\n";
                    });
                }

                // --- 3. 埋め込みメッセージの構築 ---
                await interaction.editReply({
                    embeds: [{
                        title: "📖 コマンドマニュアル (自動生成)",
                        color: 0x00AAAA, // 制御工学の図面のような落ち着いた青色
                        fields: [
                            {
                                name: "🌐 サーバー情報",
                                value: `**サーバー名**: ${guildName}\n**ID**: \`${config.guildId}\``,
                                inline: true
                            },
                            {
                                name: "📜 ログ・リポジトリ",
                                value: `**ログ**: ${logChannel}\n**Git**: ${gitRepos}`,
                                inline: true
                            },
                            {
                                name: "🎮 サーバー別チャンネル",
                                value: serverChannels,
                                inline: false
                            },
                            {
                                name: "🛠️ 利用可能なコマンド",
                                value: commandManual,
                                inline: false
                            }
                        ],
                        footer: { text: "※新しいコマンドは reload 後に反映されます" },
                        timestamp: new Date().toISOString()
                    }]
                });

            } catch (err: any) {
                console.error("Help Command Error:", err);
                await interaction.editReply(`❌ ヘルプ生成エラー: \`${err.message}\``);
            }
            return;
        }


        if (subcommand === "reload") {
            await interaction.deferReply({ ephemeral: true });

            try {
                const configPath = path.resolve(__dirname, './config.json');
                const rawConfig = fs.readFileSync(configPath, 'utf-8');
                const newConfig = JSON.parse(rawConfig);
                config = newConfig;

                discoverServers();

                // --- 修正後：変数 DiscordCommandData を配列として再利用する ---
                await client.application!.commands.set([DiscordCommandData], config.guildId);

                await interaction.editReply(`✅ **リロード成功**\n- サーバー数: ${Object.keys(detectedServers).length}\n- 設定とコマンドを同期しました。`);
                console.log("♻️ Configuration reloaded successfully.");

            } catch (err: any) {
                console.error("Reload Error:", err);
                await interaction.editReply(`❌ リロード失敗: \`${err.message}\``);
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

        if (subcommand === "stop") {
            if (!activeProcesses[port]) return interaction.reply("サーバーが起動していません。");

            const server = detectedServers[port];
            const chatChannel = client.channels.cache.get(server.channelId) as TextChannel;

            // 1. チャットチャンネルへ停止メッセージを送信
            if (chatChannel) {
                chatChannel.send({
                    embeds: [{
                        title: "Server Status",
                        description: `🛑 **Port:${port}** の停止処理を開始しました。`,
                        color: 0xffa500 // オレンジ
                    }]
                }).catch(() => {});
            }

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

        if (subcommand === "restart") {
            if (!activeProcesses[port]) return interaction.reply("サーバーが起動していないため、通常起動します。");

            const server = detectedServers[port];
            const chatChannel = client.channels.cache.get(server.channelId) as TextChannel;

            // 2. チャットチャンネルへ再起動メッセージを送信
            if (chatChannel) {
                chatChannel.send({
                    embeds: [{
                        title: "Server Status",
                        description: `🔄 **Port:${port}** の再起動シーケンスを開始しました。`,
                        color: 0xffff00 // 黄色
                    }]
                }).catch(() => {});
            }

            sendToConsole(port, "say §e[Discord] Restart the server.");

            await interaction.reply({ content: `🔄 Port ${port} の再起動を開始しました。`, ephemeral: true });

            // 再起動ロジック：停止を待ってから開始
            activeProcesses[port].once('close', () => {
                startServer(port);
            });
            sendToConsole(port, "stop");
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

app.get('/:port/status-of/:targetPort', async (req, res) => {
    const targetPort = req.params.targetPort;

    try {
        // 特定のポートの情報を検索
        const record = await PublicStatus.findOne({ port: targetPort });

        if (!record) {
            return res.status(404).json({ error: "Server not found" });
        }

        res.json({
            port: record.port,
            status: record.status,
            count: record.playerCount,
            lastUpdate: record.lastUpdate
        });
    } catch (err) {
        console.error("❌ Single-status API Error:", err);
        res.status(500).json({ error: "DB Error" });
    }
});

app.listen(9000, () => {
    console.log("Manager API is running on port 9000");
});

client.login(config.discordToken);