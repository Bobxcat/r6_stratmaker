// import * as tauri_ws from "@tauri-apps/plugin-websocket";
import WSTauri from "@tauri-apps/plugin-websocket";
import { isTauri } from "@tauri-apps/api/core";
import * as protos from "./generated_protos/primary.ts"

export class WS {
    private backendTauri: WSTauri | undefined = undefined;
    private backendWeb: WebSocket | undefined = undefined;

    private constructor() { }

    static async connect(url: string): Promise<WS> {
        let ws = new WS();
        if (isTauri()) {
            ws.backendTauri = await WSTauri.connect(url);
        } else {
            ws.backendWeb = new WebSocket(url);

            while (ws.backendWeb!.readyState == ws.backendWeb!.CONNECTING) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }

            console.log(`READY STATE: ${ws.backendWeb?.readyState}`);
        }

        return ws;
    }

    async sendRaw(msg: number[]): Promise<void> {
        if (isTauri()) {
            await this.backendTauri!.send(msg);
        } else {
            this.backendWeb!.send(Uint8Array.from(msg));
        }
    }

    async sendProto(msg: protos.Client2Server) {
        const msgRaw = protos.Client2Server.encode(msg).finish();
        await this.sendRaw(Array.from(msgRaw));
    }

    addListener(cb: (msg: protos.Server2Client) => void) {
        if (isTauri()) {
            this.backendTauri!.addListener((msg) => {
                switch (msg.type) {
                    case "Text":
                        console.error("Network messages must be in binary!");
                        break;
                    case "Binary":
                        cb(protos.Server2Client.decode(Uint8Array.from(msg.data)));
                        break;
                    case "Ping":
                        this.backendTauri?.send({ type: "Pong", data: [] });
                        break;
                    case "Pong":
                        break;
                    case "Close":
                        break;
                }
            });
        } else {
            // The browser should automatically handle ping/ponging
            this.backendWeb!.addEventListener("message", (ev) => {
                let data = ev.data as Blob;
                data.bytes().then((data) => { return cb(protos.Server2Client.decode(data)); });
            });
        }
    }
}