import {
    ApplicationCommandOptionType,
    Client,
    GuildMemberRoleManager,
    IntentsBitField,
    TextChannel,
    Events,
    ChatInputApplicationCommandData,
    EmbedBuilder
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
import https from 'https';
import type { ChildProcess } from 'child_process';

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
                },
                {
                    type: ApplicationCommandOptionType.Subcommand,
                    name: "user-list",
                    description: "指定したポートの参加者一覧を表示",
                    options: [{ type: ApplicationCommandOptionType.String, name: "port", description: "ポート番号", required: true }]
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
                },
                {
                    type: ApplicationCommandOptionType.Subcommand,
                    name: "reconnect-db",
                    description: "データベースへの再接続を手動で実行します"
                }
            ]
        },
        // グループ3: MCXboxBroadcast 操作
        {
            type: ApplicationCommandOptionType.SubcommandGroup,
            name: "mcxb",
            description: "MCXboxBroadcast (Broadcaster) の制御・管理",
            options: [
                {
                    type: ApplicationCommandOptionType.Subcommand,
                    name: "start",
                    description: "MCXboxBroadcastを起動します"
                },
                {
                    type: ApplicationCommandOptionType.Subcommand,
                    name: "stop",
                    description: "MCXboxBroadcastを停止します"
                },
                {
                    type: ApplicationCommandOptionType.Subcommand,
                    name: "restart",
                    description: "MCXboxBroadcastを再起動します"
                },
                {
                    type: ApplicationCommandOptionType.Subcommand,
                    name: "update",
                    description: "GitHub Releases から最新版を取得してアップデートします"
                },
                {
                    type: ApplicationCommandOptionType.Subcommand,
                    name: "status",
                    description: "MCXboxBroadcast の稼働状態を確認します"
                }
            ]
        }
    ]
};

// --- 外部公開用スキーマ ---
const publicStatusSchema = new mongoose.Schema({
    port: { type: String, required: true, unique: true },
    status: { type: String, enum: ['online', 'offline'], required: true },
    playerCount: { type: Number, default: 0 },
    playerNames: { type: [String], default: [] },
    lastUpdate: { type: String, required: true }
});
const PublicStatus = mongoose.model('PublicStatus', publicStatusSchema, 'RealTimeStatus');

// --- ログ保存用スキーマ ---
const serverLogSchema = new mongoose.Schema({
    source: { type: String, required: true },
    line: { type: String, required: true },
    timestamp: { type: Date, default: Date.now, expires: '7d' }
});
const ServerLog = mongoose.model('ServerLog', serverLogSchema, 'ServerLogs');

// 現在の人数だけを保持するメモリ変数
const serverStats: { [port: string]: number } = {};

// Mongoose 接続とループ開始
async function connectPublicDB() {
    try {
        await mongoose.connect(config.mongoUri, {
            family: 4,
            serverSelectionTimeoutMS: 10000,
            tlsAllowInvalidCertificates: true,
        });
        console.log("🍃 Public Database connected to 'ServerStatus' via Mongoose");
        
        updatePublicStatus();
        setInterval(updatePublicStatus, 10000);
    } catch (err) {
        console.error("❌ MongoDB connection error:", err);
    }
}

/**
 * MongoDB への接続（および再接続）を管理する関数
 */
async function connectDB(): Promise<{ success: boolean; message: string }> {
    try {
        if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
        }
        
        await mongoose.connect(config.mongoUri);
        console.log("✅ MongoDB 接続成功");
        return { success: true, message: "データベースに正常に接続されました。" };
    } catch (err: any) {
        const errorMsg = `❌ DB 接続失敗: ${err.message}`;
        console.error(errorMsg);
        
        const logChannel = client.channels.cache.get(config.logChannelId) as TextChannel;
        if (logChannel) {
            logChannel.send({
                embeds: [{
                    title: "🚨 データベース接続エラー",
                    description: `\`\`\`\n${err.stack || err.message}\n\`\`\``,
                    color: 0xff0000,
                    timestamp: new Date().toISOString()
                }]
            }).catch(() => {});
        }
        return { success: false, message: errorMsg };
    }
}

/**
 * データベースを強制リセット（切断 -> 再接続）する関数
 */
async function reconnectDB(): Promise<{ success: boolean; message: string }> {
    try {
        if (mongoose.connection.readyState !== 0) {
            console.log("🔄 既存の接続を破棄しています...");
            await mongoose.disconnect();
        }

        await mongoose.connect(config.mongoUri, {
            family: 4,
            serverSelectionTimeoutMS: 10000,
            tlsAllowInvalidCertificates: true,
        });

        const successMsg = "✅ データベースへの再接続に成功しました。";
        console.log(successMsg);
        return { success: true, message: successMsg };

    } catch (err: any) {
        const errorMsg = `❌ データベース再接続失敗: ${err.message}`;
        console.error(errorMsg);
        sendErrorToLogChannel("System", err); 
        return { success: false, message: errorMsg };
    }
}

async function updatePublicStatus() {
    const now = new Date();
    const timestamp = `${now.getFullYear()}/${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getDate().toString().padStart(2, '0')} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

    for (const port in detectedServers) {
        const isActive = activeProcesses[port] !== undefined;
        
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
                serverStats[port] = 0;
            } catch (err) {
                console.error(`❌ DB Sync Error (Offline) [Port ${port}]:`, err);
            }
        }
    }
}

const activeProcesses: { [port: string]: ChildProcessWithoutNullStreams } = {};
const messageQueues: { [port: string]: any[] } = {};
const idEvent = new EventEmitter();

// 1. 変数定義と一斉送信関数の追加
const detectedServers: { [port: string]: { path: string, cwd: string, channelIds: string[] } } = {};

function broadcastToLinkedChannels(port: string, messagePayload: any) {
    const server = detectedServers[port];
    if (!server || !server.channelIds) return;

    for (const cid of server.channelIds) {
        const channel = client.channels.cache.get(cid) as TextChannel;
        if (channel) {
            channel.send(messagePayload).catch(() => {});
        }
    }
}

// リアルタイムログ中継用のエミッター
const logEmitter = new EventEmitter();

// MCXboxBroadcast プロセスとスレッドID保持変数
let mcxbProcess: ChildProcess | null = null;
let mcxbThreadId: string | null = null;

async function startMCXB(): Promise<{ success: boolean; message: string }> {
    const jarName = config.mcxn?.jarName || "MCXboxBroadcastStandalone.jar";
    const mcxbCwd = config.mcxn?.cwd || process.cwd();

    if (mcxbProcess && !mcxbProcess.killed) {
        return { success: false, message: "⚠️ MCXboxBroadcast は既に起動しています。" };
    }

    const logChannelId = config.logChannelId;
    const logChannel = client.channels.cache.get(logChannelId) as TextChannel;
    
    // ★追加: 予備ルート用のチャンネルを取得 (未設定の場合は logChannel を代用)
    const fallbackChannel = client.channels.cache.get(config.fallbackLogChannelId || logChannelId) as TextChannel;
    
    if (!logChannel) {
        return { success: false, message: "❌ ログチャンネルが見つからないため起動を中止しました。" };
    }

    try {
        const now = new Date();
        const startTimeStr = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}`;
        const threadName = `MCXB_${startTimeStr}`;

        const thread = await logChannel.threads.create({
            name: threadName,
            autoArchiveDuration: 1440,
            reason: `MCXboxBroadcast ログ用`
        });

        mcxbThreadId = thread.id;

        mcxbProcess = spawn('java', ['-jar', jarName], {
            cwd: mcxbCwd,
            detached: false
        });

        let lineBuffer = "";

        mcxbProcess.stdout?.on('data', async (data) => {
            lineBuffer += data.toString();
            const lines = lineBuffer.split(/\r?\n/);
            lineBuffer = lines.pop() || "";

            for (const line of lines) {
                const cleanLine = line.trim();
                if (!cleanLine) continue;
                
                logEmitter.emit('log', { source: "MCXB", line: cleanLine });

                try {
                    if (mcxbThreadId) {
                        const logThread = client.channels.cache.get(mcxbThreadId) as any;
                        if (logThread) {
                            logThread.send(`\`${new Date().toLocaleTimeString()}\` \`\`\`\n${cleanLine}\n\`\`\``).catch(() => {});
                        } else {
                            // ★修正: 専用の予備チャンネルへ送信
                            if (fallbackChannel) fallbackChannel.send(`[MCXB] ${cleanLine}`).catch(() => {});
                        }
                    }
                } catch (e) {
                    console.error("MCXB Log Error:", e);
                }
            }
        });

        mcxbProcess.stderr?.on('data', async (data) => {
            const line = data.toString().trim();
            if (!line) return;

            logEmitter.emit('log', { source: "MCXB_ERR", line: line });

            // ★修正: fetch ではなく cache.get を使用
            try {
                if (mcxbThreadId) {
                    const logThread = client.channels.cache.get(mcxbThreadId) as any;
                    if (logThread) {
                        logThread.send(`\`${new Date().toLocaleTimeString()}\` **[ERR]** \`\`\`\n${line}\n\`\`\``).catch(() => {});
                    }
                }
            } catch (e) {}
        });

        mcxbProcess.on('close', (code) => {
            console.log(`[MCXB] Javaプロセスが終了しました (Code: ${code})`);
            mcxbProcess = null;
            
            if (mcxbThreadId) {
                client.channels.fetch(mcxbThreadId).then((t: any) => {
                    if (t) {
                        t.send(`🛑 MCXboxBroadcast が停止しました。 (Code: ${code})`)
                            .then(() => t.setArchived(true).catch(() => {}))
                            .catch(() => {});
                    }
                }).catch(() => {});
                mcxbThreadId = null;
            }
        });

        return { success: true, message: `🚀 MCXboxBroadcast を起動し、専用スレッドを作成しました。` };
    } catch (err: any) {
        return { success: false, message: `❌ 起動失敗: ${err.message}` };
    }
}

async function stopMCXB(): Promise<{ success: boolean; message: string }> {
    const jarName = config.mcxn?.jarName || "MCXboxBroadcastStandalone.jar";

    try {
        if (process.platform === 'win32') {
            await execAsync(`wmic process where "CommandLine like '%${jarName}%'" call terminate`).catch(() => {});
        }
        
        if (mcxbProcess) {
            mcxbProcess.kill();
            mcxbProcess = null;
        }

        return { success: true, message: "🛑 MCXboxBroadcast を停止しました。" };
    } catch (err: any) {
        return { success: false, message: `❌ 停止失敗: ${err.message}` };
    }
}

function downloadLatestRelease(downloadUrl: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = (url: string) => {
            https.get(url, { headers: { 'User-Agent': 'Node.js-Bot' } }, (response) => {
                if (response.statusCode === 301 || response.statusCode === 302) {
                    return request(response.headers.location!);
                }
                
                if (response.statusCode !== 200) {
                    return reject(new Error(`Download failed with status code ${response.statusCode}`));
                }

                const contentLength = parseInt(response.headers['content-length'] || '0', 10);
                
                const file = fs.createWriteStream(destPath);
                response.pipe(file);
                
                file.on('finish', () => {
                    file.close(() => {
                        const stats = fs.statSync(destPath);
                        
                        if (contentLength > 0 && stats.size !== contentLength) {
                            fs.unlink(destPath, () => {}); 
                            reject(new Error(`ダウンロードが途中で切断されました (取得: ${stats.size} byte / 期待値: ${contentLength} byte)`));
                        } else if (stats.size < 1024) {
                            reject(new Error(`ファイルが破損しているか空です (サイズ: ${stats.size} バイト)`));
                        } else {
                            resolve(); 
                        }
                    });
                });
                
                file.on('error', (err) => {
                    fs.unlink(destPath, () => {});
                    reject(err);
                });
            }).on('error', (err) => {
                if (fs.existsSync(destPath)) fs.unlink(destPath, () => {});
                reject(err);
            });
        };
        
        request(downloadUrl);
    });
}

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

async function restartServer(port: string) {
    if (activeProcesses[port]) {
        return new Promise<void>((resolve) => {
            activeProcesses[port].once('close', async () => {
                await startServer(port);
                resolve();
            });
            sendToConsole(port, "stop");
        });
    } else {
        await startServer(port);
    }
}

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

// 2. サーバー検出処理の修正
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
                
                let cIds: string[] = [];
                if (mapping) {
                    if (Array.isArray(mapping.channelIds)) cIds = mapping.channelIds;
                    else if (typeof mapping.channelId === "string") cIds = [mapping.channelId];
                }

                detectedServers[port] = {
                    path: finalPath,
                    cwd: folderPath,
                    channelIds: cIds.length > 0 ? cIds : [config.logChannelId]
                };
                console.log(`✅ 発見: Port ${port} -> ${finalPath} (同期先: ${cIds.length}チャンネル)`);
            }
        }
    }
}

function generateStatusEmbed() {
    const list = Object.keys(detectedServers).map(p => {
        const active = activeProcesses[p] !== undefined;
        const threadId = activeThreads[p];
        const threadLink = (active && threadId) ? `\n └ ログ: <#${threadId}>` : "";
        return `**Port ${p}**: ${active ? "🟢 起動中" : "🔴 停止中"}${threadLink}`;
    });

    return {
        title: "📊 サーバーリアルタイム稼働状況",
        description: list.join("\n") || "サーバーが検出されていません。",
        color: 0x5865F2,
        footer: { text: `最終更新: ${new Date().toLocaleString("ja-JP")}` }
    };
}

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
            const { stdout: pullOut } = await execAsync('git pull', { cwd: targetPath });
            results += `✅ ${folder}: Pull \`${pullOut.trim() || "Already up to date."}\`\n`;

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

            results += `   ⏳ コンパイル中 (\`tsc -d\`)...`;
            try {
                await execAsync('npm install', { cwd: targetPath });
                await execAsync('tsc -d', { cwd: targetPath });
                results += ` ✅ 成功\n`;
            } catch (e: any) {
                const detail = e.stdout || e.message;
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

async function runBackup(port: string, serverCwd: string) {
    const managerDir = path.resolve(__dirname);
    const backupBaseDir = path.join(managerDir, "..", "_backups");
    const portBackupDir = path.join(backupBaseDir, port);
    const tempStageDir = path.join(backupBaseDir, "temp_stage", port);

    if (!fs.existsSync(portBackupDir)) fs.mkdirSync(portBackupDir, { recursive: true });

    const existingFiles = fs.readdirSync(portBackupDir)
        .filter(f => f.endsWith('.zip'))
        .map(f => ({ name: f, time: fs.statSync(path.join(portBackupDir, f)).mtime.getTime() }))
        .sort((a, b) => b.time - a.time);

    const prevBackup = existingFiles[0];
    let prevSize = 0;
    if (prevBackup) {
        prevSize = fs.statSync(path.join(portBackupDir, prevBackup.name)).size;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `world_backup_${timestamp}.zip`;
    const destPath = path.join(portBackupDir, fileName);
    const worldPath = path.join(serverCwd, "worlds");

    try {
        if (fs.existsSync(tempStageDir)) fs.rmSync(tempStageDir, { recursive: true, force: true });
        
        const copyCommand = `robocopy "${worldPath}" "${tempStageDir}" /S /E /COPY:DAT /R:0 /W:0 /NP /NFL /NDL`;
        try { await execAsync(copyCommand); } catch (e: any) { if (e.code > 7) throw e; }

        const zipCommand = `powershell -Command "Compress-Archive -Path '${tempStageDir}\\*' -DestinationPath '${destPath}' -Force"`;
        await execAsync(zipCommand);
    } finally {
        if (fs.existsSync(tempStageDir)) fs.rmSync(tempStageDir, { recursive: true, force: true });
    }

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

const activeThreads: { [port: string]: string } = {};

async function startServer(port: string) {
    const server = detectedServers[port];
    if (!server || activeProcesses[port]) return;

    const logChannel = client.channels.cache.get(config.logChannelId) as TextChannel;
    if (!logChannel) return console.error("❌ ログチャンネルが見つかりません。");

    // ★追加: 予備ルート用のチャンネルを取得
    const fallbackChannel = client.channels.cache.get(config.fallbackLogChannelId || config.logChannelId) as TextChannel;

    const now = new Date();
    const startTimeStr = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}`;
    const threadName = `${port}_${startTimeStr}`;

    const thread = await logChannel.threads.create({
        name: threadName,
        autoArchiveDuration: 1440,
        reason: `BDS Port ${port} ログ用`
    });

    activeThreads[port] = thread.id;

    const child = spawn(server.path, [], { cwd: server.cwd });
    activeProcesses[port] = child;
    saveState();

    // 3. 起動通知の修正
    broadcastToLinkedChannels(port, {
        embeds: [{ title: "Server Status", description: `🚀 **Port:${port}** が起動しました。`, color: 0x00ff00 }]
    });

    let lineBuffer = "";

    child.stdout.on('data', async (data) => {
        lineBuffer += data.toString();
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() || "";

        for (const line of lines) {
            const cleanLine = line.trim();
            if (!cleanLine) continue;
            
            logEmitter.emit('log', { source: port, line: cleanLine });

            try {
                const logThread = client.channels.cache.get(activeThreads[port]) as any;
                if (logThread) {
                    logThread.send(`\`${new Date().toLocaleTimeString()}\` \`\`\`\n${cleanLine}\n\`\`\``).catch(() => {});
                } else {
                    // ★修正: 専用の予備チャンネルへ送信
                    if (fallbackChannel) fallbackChannel.send(`[${port}] ${cleanLine}`).catch(() => {});
                }
            } catch (e) {
                console.error(`BDS Log Error [Port ${port}]:`, e);
            }
            
            // 3. 参加・退出ログの修正
            if (cleanLine.includes("Player connected:")) {
                const name = cleanLine.match(/Player connected: ([^,]+)/)?.[1];
                if (name) {
                    broadcastToLinkedChannels(port, {
                        embeds: [{
                            title: "Join",
                            description: `**${name}** が参加しました。`,
                            color: 0x00ff00
                        }]
                    });
                }
            }

            if (cleanLine.includes("Player disconnected:")) {
                const name = cleanLine.match(/Player disconnected: ([^,]+)/)?.[1];
                if (name) {
                    broadcastToLinkedChannels(port, {
                        embeds: [{
                            title: "Leave",
                            description: `**${name}** が退出しました。`,
                            color: 0xff0000
                        }]
                    });
                }
            }
        }
    });

    child.on('close', (code) => {
        delete activeProcesses[port];
        delete activeThreads[port];
        saveState();
        
        // 3. 停止通知の修正
        broadcastToLinkedChannels(port, {
            embeds: [{
                title: "Server Status",
                description: `🛑 **Port:${port}** が完全に停止しました。(Code: ${code})\n※再起動の場合は、この後すぐに起動通知が流れます。`,
                color: 0xff0000
            }]
        });
        
        const thread = client.channels.cache.get(activeThreads[port]) as any;
        if (thread) {
            thread.send(`🛑 サーバーが停止しました。 (Code: ${code})`)
                .then(() => {
                    thread.setArchived(true).catch(() => {});
                })
                .catch(() => {});
        }
    });
}

function sendErrorToLogChannel(port: string, error: any) {
    const logChannelId = config.logChannelId;
    const logChannel = client.channels.cache.get(logChannelId) as TextChannel;

    if (logChannel) {
        logChannel.send({
            embeds: [{
                title: "⚠️ システムエラー通知",
                description: `**Port ${port}** で問題が発生しました。`,
                fields: [
                    { name: "エラー内容", value: `\`\`\`\n${error.message || error}\n\`\`\`` }
                ],
                color: 0xff0000,
                timestamp: new Date().toISOString()
            }]
        }).catch(err => console.error("Discord へのログ送信に失敗しました:", err));
    }
    
    console.error(`[Port ${port}] Error:`, error);
}

client.once(Events.ClientReady, async (readyClient) => {
    discoverServers();
    checkOrphanedProcesses();
    await connectPublicDB();
    console.log(`🚀 Manager connected to Discord & Public DB`);
});

client.on('ready', async () => {
    discoverServers();
    checkOrphanedProcesses();
    console.log(`🚀 Manager logged in as ${client.user!.tag}`);
    await client.application!.commands.set([DiscordCommandData], config.guildId);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "admin") return;

    const cmdChannelId = config.commandChannelId || config.logChannelId;
    if (interaction.channelId !== cmdChannelId) {
        return interaction.reply({ 
            content: `❌ 管理コマンドは指定された管制チャンネル (<#${cmdChannelId}>) でのみ実行可能です。`, 
            ephemeral: true 
        });
    }

    const roleId = config.commands.opCommands.roleId;
    if (!(interaction.member?.roles as GuildMemberRoleManager).cache.has(roleId)) {
        return interaction.reply({ content: "実行権限がありません。", ephemeral: true });
    }

    const group = interaction.options.getSubcommandGroup();
    const subcommand = interaction.options.getSubcommand();

    if (group === "system") {
        if (subcommand === "update-bds") {
            await interaction.deferReply();

            const rootDir = path.join(process.cwd(), "..");
            const updaterPath = path.join(rootDir, "BDS-Updater", "src", "DownloadBDS.js");
            const logFileName = `update_log_${Date.now()}.txt`;

            if (!fs.existsSync(updaterPath)) {
                return interaction.editReply(`❌ アップデーターが見つかりません。`);
            }

            const runningPorts = Object.keys(activeProcesses);

            if (runningPorts.length > 0) {
                await interaction.editReply(`⏳ 稼働中のサーバー (${runningPorts.join(", ")}) を停止してからアップデートを開始します...`);

                const stopPromises = runningPorts.map(port => {
                    return new Promise<void>((resolve) => {
                        const proc = activeProcesses[port];
                        if (proc) {
                            proc.once('close', () => resolve());
                            sendToConsole(port, "stop");
                        } else {
                            resolve();
                        }
                    });
                });

                await Promise.all(stopPromises);
                await interaction.editReply(`✅ 全サーバーの停止を確認。アップデートを実行中...`);
            }

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
            if (currentMonitorInterval) {
                clearInterval(currentMonitorInterval);
                currentMonitorInterval = null;
            }

            await interaction.reply({ 
                embeds: [generateStatusEmbed()] 
            });

            currentMonitorInterval = setInterval(async () => {
                try {
                    await interaction.editReply({ 
                        embeds: [generateStatusEmbed()] 
                    });
                } catch (error) {
                    if (currentMonitorInterval) {
                        clearInterval(currentMonitorInterval);
                        currentMonitorInterval = null;
                    }
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
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }

        if (subcommand === "help") {
            await interaction.deferReply({ ephemeral: true });

            try {
                const guildName = interaction.guild?.name || "不明なサーバー";
                const logChannel = `<#${config.logChannelId}>`;
                
                const serverChannels = Object.entries(config.servers)
                    .map(([port, data]: [string, any]) => {
                        // channelIds配列対応
                        const channels = data.channelIds ? data.channelIds.map((id: string) => `<#${id}>`).join(", ") : `<#${data.channelId}>`;
                        return `・Port **${port}**: ${channels}`;
                    })
                    .join("\n") || "未設定";

                const gitRepos = config.system.gitpull_target
                    .map((repo: string) => `\`${repo}\``)
                    .join(", ") || "なし";

                const commands = await interaction.guild?.commands.fetch();
                const adminCommand = commands?.find(cmd => cmd.name === "admin");

                if (!adminCommand || !adminCommand.options) {
                    return interaction.editReply("❌ コマンド情報の取得に失敗しました。");
                }

                const embeds: any[] = [{
                    title: "🌐 システム構成情報",
                    color: 0x2B2D31,
                    fields: [
                        { name: "サーバー名", value: `${guildName} (\`${config.guildId}\`)`, inline: true },
                        { name: "ログ・Git", value: `ログ: ${logChannel}\nリポジトリ: ${gitRepos}`, inline: true },
                        { name: "🎮 サーバー別チャンネル", value: serverChannels, inline: false }
                    ]
                }];

                adminCommand.options.forEach(opt => {
                    if (opt.type === ApplicationCommandOptionType.SubcommandGroup) {
                        let groupText = "";
                        opt.options?.forEach(sub => {
                            groupText += `└ \`/admin ${opt.name} ${sub.name}\` - ${sub.description}\n`;
                        });

                        let embedColor = 0x5865F2;
                        if (opt.name === "server") embedColor = 0x57F287;
                        if (opt.name === "system") embedColor = 0xED4245;
                        if (opt.name === "mcxb") embedColor = 0xFEE75C;

                        embeds.push({
                            title: `🛠️ ${opt.name.toUpperCase()} コマンド`,
                            description: groupText || "コマンドがありません",
                            color: embedColor
                        });
                    }
                });

                if (embeds.length > 0) {
                    embeds[embeds.length - 1].footer = { text: "※新しいコマンドは reload 後に反映されます" };
                    embeds[embeds.length - 1].timestamp = new Date().toISOString();
                }

                await interaction.editReply({ embeds: embeds });

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

                await client.application!.commands.set([DiscordCommandData], config.guildId);

                await interaction.editReply(`✅ **リロード成功**\n- サーバー数: ${Object.keys(detectedServers).length}\n- 設定とコマンドを同期しました。`);
                console.log("♻️ Configuration reloaded successfully.");

            } catch (err: any) {
                console.error("Reload Error:", err);
                await interaction.editReply(`❌ リロード失敗: \`${err.message}\``);
            }
            return;
        }

        if (subcommand === "reconnect-db") {
            await interaction.deferReply();
            
            const result = await reconnectDB();
            
            await interaction.editReply({
                embeds: [{
                    title: "🔌 Database Reconnection",
                    description: result.message,
                    color: result.success ? 0x00ff00 : 0xff0000,
                    timestamp: new Date().toISOString()
                }]
            });
        }
    }

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

            // 4. 管理コマンドの修正
            broadcastToLinkedChannels(port, {
                embeds: [{
                    title: "Server Status",
                    description: `🛑 **Port:${port}** の停止処理を開始しました。`,
                    color: 0xffa500
                }]
            });

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
                sendToConsole(port, "say §e[Backup] World backup starting. Writing will be paused...");
                
                // 4. 管理コマンドの修正
                broadcastToLinkedChannels(port, {
                    embeds: [{
                        title: "💾 Backup Status",
                        description: `🔄 **Port:${port}** のバックアップ処理を開始しました。`,
                        color: 0xffa500
                    }]
                });

                sendToConsole(port, "save hold");
                await new Promise(resolve => setTimeout(resolve, 5000)); 

                const result = await runBackup(port, server.cwd);

                sendToConsole(port, "save resume");
                sendToConsole(port, `say §a[Backup] Backup completed successfully. (Size: ${result.size})`);

                const deltaInfo = result.isFirst ? " (初回)" : ` (前回比: \`${result.delta}\`)`;
                const successMsg = `✅ **バックアップ完了**\n- ファイル: \`${result.fileName}\`\n- サイズ: \`${result.size}\`${deltaInfo}`;

                await interaction.editReply(successMsg);

                // 4. 管理コマンドの修正
                broadcastToLinkedChannels(port, {
                    embeds: [{
                        title: "💾 Backup Status",
                        description: `✅ **Port:${port}** のバックアップが完了しました。\n${successMsg}`,
                        color: 0x00ff00
                    }]
                });

            } catch (err: any) {
                sendToConsole(port, "save resume"); 
                sendToConsole(port, "say §c[Backup] バックアップ中にエラーが発生しました。");
                
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
                .slice(0, 10);

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

            // 4. 管理コマンドの修正
            broadcastToLinkedChannels(port, {
                embeds: [{
                    title: "Server Status",
                    description: `🔄 **Port:${port}** の再起動シーケンスを開始しました。`,
                    color: 0xffff00
                }]
            });

            sendToConsole(port, "say §e[Discord] Restart the server.");

            await interaction.reply({ content: `🔄 Port ${port} の再起動を開始しました。`, ephemeral: true });

            activeProcesses[port].once('close', () => {
                startServer(port);
            });
            sendToConsole(port, "stop");
        }

        if (subcommand === "user-list") {
            await interaction.deferReply();
            const port = interaction.options.getString("port", true);
            const server = detectedServers[port];

            try {
                const record = await PublicStatus.findOne({ port: port });
                
                if (!record || record.status === 'offline') {
                    return interaction.editReply(`❌ Port ${port} はオフライン、またはデータがありません。`);
                }

                let maxPlayers = "不明";
                if (server) {
                    const propPath = path.join(server.cwd, "server.properties");
                    if (fs.existsSync(propPath)) {
                        const content = fs.readFileSync(propPath, 'utf-8');
                        const match = content.match(/max-players=(\d+)/);
                        if (match) maxPlayers = match[1];
                    }
                }

                const playerNames = record.playerNames && record.playerNames.length > 0 
                    ? record.playerNames.join("\n") 
                    : "参加中のプレイヤーはいません。";

                await interaction.editReply({
                    embeds: [{
                        title: `👥 参加者リスト - Port ${port}`,
                        color: 0x00FF7F,
                        fields: [
                            {
                                name: "📊 接続状況",
                                value: `**${record.playerCount}** / **${maxPlayers}** 人`,
                                inline: true
                            },
                            {
                                name: "🕒 最終同期",
                                value: `<t:${Math.floor(new Date(record.lastUpdate).getTime() / 1000)}:R>`,
                                inline: true
                            },
                            {
                                name: "👤 参加中のプレイヤー",
                                value: `\`\`\`\n${playerNames}\n\`\`\``,
                                inline: false
                            }
                        ],
                        footer: { text: "※10秒周期で更新されるDB値を参照しています" },
                        timestamp: new Date().toISOString()
                    }]
                });

            } catch (err: any) {
                console.error("User List Error:", err);
                await interaction.editReply(`❌ データの取得中にエラーが発生しました: \`${err.message}\``);
            }
            return;
        }
    }

    if (group === "mcxb") {
        await interaction.deferReply();

        if (subcommand === "start") {
            const res = await startMCXB();
            await interaction.editReply(res.message);
        }

        else if (subcommand === "stop") {
            const res = await stopMCXB();
            await interaction.editReply(res.message);
        }

        else if (subcommand === "restart") {
            await interaction.editReply("🔄 MCXboxBroadcast を再起動しています...");
            await stopMCXB();
            
            setTimeout(async () => {
                const res = await startMCXB();
                interaction.followUp(res.message);
            }, 3000);
        }

        else if (subcommand === "update") {
            await interaction.editReply("📦 GitHub から最新リリース情報を取得中...");

            try {
                const repoOwner = config.mcxn?.repoOwner || "MCXboxBroadcast";
                const repoName = config.mcxn?.repoName || "Broadcaster";
                const jarName = config.mcxn?.jarName || "MCXboxBroadcastStandalone.jar";
                const mcxbCwd = config.mcxn?.cwd || process.cwd();

                if (!fs.existsSync(mcxbCwd)) {
                    fs.mkdirSync(mcxbCwd, { recursive: true });
                }

                const apiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/releases/latest`;
                
                const fetchRes = await new Promise<string>((resolve, reject) => {
                    https.get(apiUrl, { headers: { 'User-Agent': 'Node.js-Bot' } }, (res) => {
                        if (res.statusCode !== 200) {
                            return reject(new Error(`API Error: ${res.statusCode} ${res.statusMessage}`));
                        }
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => resolve(data));
                    }).on('error', reject);
                });

                const releaseData = JSON.parse(fetchRes);
                const tagName = releaseData.tag_name;

                const jarAsset = releaseData.assets?.find((asset: any) => 
                        asset.name.toLowerCase().includes('standalone') && asset.name.endsWith('.jar')
                    ) || releaseData.assets?.find((asset: any) => asset.name.endsWith('.jar'));
                if (!jarAsset) {
                    throw new Error("最新リリースに .jar ファイルが見つかりませんでした。");
                }

                await interaction.editReply(`📥 最新版 **${tagName}** (${jarAsset.name}) を検出。プロセスの停止と \`${mcxbCwd}\` へのダウンロードを開始します...`);

                await stopMCXB();

                const targetPath = path.join(mcxbCwd, jarName);
                const backupPath = path.join(mcxbCwd, `${jarName}.bak`);

                if (fs.existsSync(targetPath)) {
                    fs.copyFileSync(targetPath, backupPath);
                }

                await downloadLatestRelease(jarAsset.browser_download_url, targetPath);

                await interaction.followUp({
                    embeds: [{
                        title: "✅ MCXboxBroadcast アップデート完了",
                        description: `バージョン **${tagName}** の取得が完了し、指定ディレクトリ (\`${mcxbCwd}\`) に配置しました。\n自動再起動を開始します...`,
                        color: 0x00ff00,
                        timestamp: new Date().toISOString()
                    }]
                });

                await startMCXB();

            } catch (err: any) {
                await interaction.followUp(`❌ アップデート失敗:\n\`\`\`\n${err.message}\n\`\`\``);
            }
        }

        else if (subcommand === "status") {
            const isRunning = mcxbProcess !== null && !mcxbProcess.killed;
            const jarName = config.mcxn?.jarName || "MCXboxBroadcastStandalone.jar";
            
            const threadLink = (isRunning && mcxbThreadId) ? `\n└ ログスレッド: <#${mcxbThreadId}>` : "";

            await interaction.editReply({
                embeds: [{
                    title: "📡 MCXboxBroadcast 稼働状態",
                    description: `ステータス: **${isRunning ? "🟢 稼働中" : "🔴 停止中"}**${threadLink}\n実行コマンド: \`java -jar ${jarName}\``,
                    color: isRunning ? 0x00ff00 : 0xff0000,
                    timestamp: new Date().toISOString()
                }]
            });
        }
    }
});

client.on('messageCreate', (message) => {
    if (message.author.bot) return;

    for (const port in detectedServers) {
        const channelIds = detectedServers[port].channelIds;

        if (channelIds && channelIds.includes(message.channel.id)) {
            
            getQueue(port).push({
                type: "message",
                author:  message.author.displayName,
                content: message.content
            });

            // Discord間のチャットミラーリング転送
            for (const cid of channelIds) {
                if (cid !== message.channel.id) {
                    const otherChannel = client.channels.cache.get(cid) as TextChannel;
                    if (otherChannel) {
                        otherChannel.send({
                            embeds: [{
                                author: { name: message.author.displayName, icon_url: message.author.displayAvatarURL() },
                                description: message.content,
                                color: 0x8a2be2
                            }]
                        }).catch(() => {});
                    }
                }
            }
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

app.post('/:port/list', async (req, res) => {
    const port = req.params.port;
    const { players, names, id } = req.body;

    if (players === undefined) return res.sendStatus(400);

    const count = Number(players);
    serverStats[port] = count; 

    if (mongoose.connection.readyState === 1) {
        try {
            const now = new Date();
            const timestamp = `${now.getFullYear()}/${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getDate().toString().padStart(2, '0')} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

            await PublicStatus.findOneAndUpdate(
                { port: port },
                {
                    status: 'online',
                    playerCount: count,
                    playerNames: names || [],
                    lastUpdate: timestamp
                },
                { upsert: true }
            );
        } catch (err: any) {
            sendErrorToLogChannel(port, err); 
        }
    } else {
        console.log(`⚠️ DB Offline (Port ${port}): 接続待ちのためメモリ更新のみ行いました。readyState: ${mongoose.connection.readyState}`);
    }

    idEvent.emit(id, { players });
    res.sendStatus(200);
});

// スコアボード一斉送信API
app.post('/:port/scoreboard', (req, res) => {
    const port = req.params.port;
    const { scoreboard_title, content } = req.body;
    
    broadcastToLinkedChannels(port, {
        embeds: [new EmbedBuilder()
            .setTitle(`📊 ${scoreboard_title}`)
            .setDescription(content || "データなし")
            .setColor(0x00ffff)
            .setTimestamp()
        ]
    });
    res.sendStatus(200);
});

// メッセージ一斉送信API
app.post('/:port/send', (req, res) => {
    const port = req.params.port;
    const { author, content } = req.body;
    
    broadcastToLinkedChannels(port, {
        embeds: [{ title: author, description: content, color: 0x0000ff }]
    });
    res.sendStatus(200);
});

app.post('/:port/join', (req, res) => {
    res.sendStatus(200);
});

app.post('/:port/leave', (req, res) => {
    res.sendStatus(200);
});

app.get('/:port/status-of/:targetPort', async (req, res) => {
    const targetPort = req.params.targetPort;

    try {
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

app.get('/:port/user-list/:targetPort', async (req, res) => {
    const targetPort = req.params.targetPort;
    const server = detectedServers[targetPort];

    try {
        const record = await PublicStatus.findOne({ port: targetPort });
        if (!record) return res.status(404).json({ error: "No data" });

        let maxPlayers = "不明";
        if (server) {
            const propPath = path.join(server.cwd, "server.properties");
            if (fs.existsSync(propPath)) {
                const content = fs.readFileSync(propPath, 'utf-8');
                const match = content.match(/max-players=(\d+)/);
                if (match) maxPlayers = match[1];
            }
        }

        res.json({
            names: record.playerNames,
            count: record.playerCount,
            max: maxPlayers
        });
    } catch (err) { res.status(500).send(err); }
});

setInterval(async () => {
    if (mongoose.connection.readyState === 0) {
        console.warn("⚠️ データベースが切断されています。自動復旧を開始します...");
        await reconnectDB();
    }
}, 60000);

app.get('/logs', (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="ja">
    <head>
        <meta charset="UTF-8">
        <title>Realtime Server Logs</title>
        <style>
            body { background: #1e1e1e; color: #cccccc; font-family: Consolas, monospace; margin: 0; padding: 20px; }
            h2 { color: #4CAF50; margin-top: 0; display: flex; align-items: center; gap: 10px; }
            select { background: #333; color: #fff; border: 1px solid #555; padding: 5px; margin-bottom: 15px; font-size: 16px; }
            #terminal { background: #000; padding: 15px; border-radius: 5px; height: 75vh; overflow-y: auto; box-shadow: inset 0 0 10px rgba(0,0,0,0.8); }
            .log-line { margin-bottom: 4px; word-wrap: break-word; font-size: 14px; line-height: 1.4; border-bottom: 1px solid #222; padding-bottom: 2px; }
            .source-tag { font-weight: bold; padding: 2px 6px; border-radius: 3px; margin-right: 8px; display: inline-block; min-width: 50px; text-align: center; }
            .tag-MCXB { background: #d32f2f; color: #fff; }
            .tag-MCXB_ERR { background: #ff0000; color: #fff; font-weight: 900; border: 1px solid yellow; }
            .tag-BDS { background: #1976d2; color: #fff; }
            .time { color: #888; margin-right: 8px; }
        </style>
    </head>
    <body>
        <h2>📡 Server Control Tower Logs</h2>
        <select id="filter">
            <option value="ALL">ALL (すべてのログ)</option>
            <option value="MCXB">MCXBのみ</option>
            <option value="BDS">BDS (Minecraft) のみ</option>
        </select>
        <div id="terminal"></div>

        <script>
            const terminal = document.getElementById('terminal');
            const filter = document.getElementById('filter');
            
            const eventSource = new EventSource('/logs/stream');

            eventSource.onmessage = function(event) {
                const data = JSON.parse(event.data);
                const currentFilter = filter.value;
                
                const isMCXB = data.source.toString().includes("MCXB");
                if (currentFilter === 'MCXB' && !isMCXB) return;
                if (currentFilter === 'BDS' && isMCXB) return;

                let tagClass = isMCXB ? (data.source === "MCXB_ERR" ? "tag-MCXB_ERR" : "tag-MCXB") : "tag-BDS";
                const timeStr = new Date().toLocaleTimeString();
                
                const div = document.createElement('div');
                div.className = 'log-line';
                const safeLine = data.line.replace(/[&<>'"]/g, tag => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[tag]));
                div.innerHTML = \`<span class="time">[\${timeStr}]</span><span class="source-tag \${tagClass}">\${data.source}</span> \${safeLine}\`;
                
                terminal.appendChild(div);

                if (terminal.scrollHeight - terminal.scrollTop <= terminal.clientHeight + 50) {
                    terminal.scrollTop = terminal.scrollHeight;
                }
                
                if (terminal.childElementCount > 2000) {
                    terminal.removeChild(terminal.firstChild);
                }
            };
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

app.get('/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const listener = (data: { source: string, line: string }) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    logEmitter.on('log', listener);

    req.on('close', () => {
        logEmitter.removeListener('log', listener);
    });
});

const logBuffer: { source: string, line: string, timestamp: Date }[] = [];

logEmitter.on('log', (data) => {
    logBuffer.push({
        source: data.source,
        line: data.line,
        timestamp: new Date()
    });
});

setInterval(async () => {
    if (logBuffer.length === 0) return; 
    if (mongoose.connection.readyState !== 1) return; 

    const logsToWrite = [...logBuffer];
    logBuffer.length = 0;

    try {
        await ServerLog.insertMany(logsToWrite);
    } catch (err: any) {
        console.error("❌ DB Log Sync Error:", err.message);
    }
}, 5000);

app.listen(9000, () => {
    console.log("Manager API is running on port 9000");
});

client.login(config.discordToken);