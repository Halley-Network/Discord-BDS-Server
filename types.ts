export type MessageQueue = {
    type: "message";
    content: string;
    author: string;
    date: number;
} | {
    type: "eval";
    id: string;
    content: string;
    date: number;
} | {
    type: "list";
    id: string;
    date: number;
}
