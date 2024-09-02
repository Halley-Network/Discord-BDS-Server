import { ApplicationCommandOptionType, Client, GuildMemberRoleManager, IntentsBitField, TextChannel } from 'discord.js';
import { default as express } from 'express';
import { default as bodyParser } from "body-parser";
import { MessageQueue } from './types';
import * as config from './config.json';
import * as packageJson from './package.json';
import EventEmitter from 'events';
const client = new Client({ intents: [IntentsBitField.Flags.Guilds, IntentsBitField.Flags.GuildMessages, IntentsBitField.Flags.MessageContent] });
const app = express();
const messageQueue: MessageQueue[] = [];
const idEvent = new EventEmitter();

client.on('ready', async () => {
    console.log(`Logged in as ${client.user!.tag}!`);
    await client.application!.commands.set([
        {
            name: "list",
            description: "プレイヤーのリストを返却します。"
        },
        {
            name: "eval",
            description: "コマンドを実行します。",
            options: [
                {
                    type: ApplicationCommandOptionType.String,
                    name: "command",
                    description: "実行するコマンド",
                    required: true
                }
            ]
        },
        {
            name: "info",
            description: "プラグイン製作者の情報を表示します。",
        },
        {
            name: "ping",
            description: "botの応答確認をします。",
        }
    ], config.guildId);
});

client.on('messageCreate', (message) => {
    if (message.channelId != config.usingChannelId) return;
    if (message.author.bot) return;
    messageQueue.push({
        type: "message",
        author: message.author.displayName,
        content: message.content,
        date: Date.now(),
    });
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;
    if (interaction.channelId != config.usingChannelId) return;
    if (interaction.user.bot) return;
    if (interaction.commandName === "list") {
        messageQueue.push({
            type: "list",
            id: interaction.id,
            date: Date.now(),
        });
        const result = await waitId<{ players: string[], max: number }>(interaction.id);
        interaction.reply({
            ephemeral: true,
            embeds: [{
                description: result.players.length == 0 ? "プレイヤーはいません。" : "- " + result.players.join("- \n"),
                title: "Player List",
                color: 0x0000ff,
                footer: {
                    text: `${result.players.length}/${result.max}`
                }
            }]
        })
    } else if (interaction.commandName === "eval") {
        if (!(interaction.member?.roles as GuildMemberRoleManager).cache.has(config.commands.opCommands.roleId)) {
            return interaction.reply({
                ephemeral: true,
                embeds: [{
                    title: "Error",
                    description: "このコマンドを実行する権限がありません。",
                    color: 0xff0000
                }]
            })
        }
        messageQueue.push({
            type: "eval",
            id: interaction.id,
            content: interaction.options.get("command", true).value as string,
            date: Date.now(),
        });
        const result = await waitId<{ status: boolean }>(interaction.id);
        interaction.reply({
            ephemeral: true,
            embeds: [{
                color: result.status ? 0x00ff00 : 0xff0000,
                description: result.status ? "正常に実行しました。" : "実行に失敗しました。",
                title: result.status ? "Success" : "Error",
            }]
        })
    } else if (interaction.commandName === "info") {
        interaction.reply({
            ephemeral: true,
            embeds: [{
                title: "Plugin Info",
                description: `Plugin by: kaito0202024\nVersion: ${packageJson.version}`,
                color: 0x00ff00
            }]
        });
    } else if (interaction.commandName === "ping") {
        interaction.reply({
            ephemeral: true,
            content: "Pong!"
        });
    }
});

function waitId<T>(id: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject("Timeout");
        }, 1000 * 60);
        idEvent.once(id, (value: T) => {
            clearTimeout(timer);
            resolve(value);
        });
    });
}
app.use(bodyParser.urlencoded({
    extended: true
}));
app.use(bodyParser.json());
app.get('/messages', (req, res) => {
    const since = Number(req.query.since);
    if (isNaN(since)) {
        res.status(400).send("Invalid query parameter.");
        return;
    }
    const resArray: MessageQueue[] = [];
    const queueLength = messageQueue.length;
    for (let i = 0; i < queueLength; i++) {
        const data = messageQueue.shift()!;
        if (data.date >= since) resArray.push(data);
    }
    res.json(resArray);
});
app.post('/eval', (req, res) => {
    const { id, status } = req.body as { id: string, status: boolean };
    idEvent.emit(id, { status });
    res.sendStatus(200);
});
app.post('/list', (req, res) => {
    const { id, players, max } = req.body as { id: string, players: string[], max: number };
    idEvent.emit(id, { players, max });
    res.sendStatus(200);
});
app.post('/send', (req, res) => {
    const { author, content } = req.body as { author: string, content: string };
    (client.channels.cache.get(config.usingChannelId) as TextChannel).send({
        embeds: [{
            title: author,
            description: content,
            color: 0x0000ff
        }]
    })
});
app.post('/join', (req, res) => {
    const { player } = req.body as { player: string };
    (client.channels.cache.get(config.usingChannelId) as TextChannel).send({
        embeds: [{
            title: "Join",
            description: `**${player}がサーバーにログインしました。**`,
            color: 0x00ff00
        }]
    })
});
app.post('/leave', (req, res) => {
    const { player } = req.body as { player: string };
    (client.channels.cache.get(config.usingChannelId) as TextChannel).send({
        embeds: [{
            title: "Leave",
            description: `**${player}がサーバーからログアウトしました。**`,
            color: 0xff0000
        }]
    })
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});
client.login(config.discordToken).catch(console.error)
