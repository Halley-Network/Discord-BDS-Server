export type MessageQueue = {
    type: "message" | "list" | "eval";
    author?: string;
    content?: string;
    date: number;
    id?: string;
    port?: string;
}


export interface Config {
    discordToken: string;
    guildId: string;
    usingChannelId: string;
    channelIds: Record<string, string>; // ← ここを追加
    commands: {
        enableNormalCommands: boolean;
        opCommands: {
        enable: boolean;
        roleId: string;
        };
    };
}