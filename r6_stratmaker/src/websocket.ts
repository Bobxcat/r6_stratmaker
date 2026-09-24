// import * as tauri_ws from "@tauri-apps/plugin-websocket";
import WSTauri from "@tauri-apps/plugin-websocket";
import { isTauri } from "@tauri-apps/api/core";

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
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            console.log(`READY STATE: ${ws.backendWeb?.readyState}`);
        }
        return ws;
    }

    async send(msg: number[]): Promise<void> {
        if (isTauri()) {
            await this.backendTauri!.send(msg);
        } else {
            this.backendWeb!.send(Uint8Array.from(msg));
        }
    }

    addListener(cb: (msg: Uint8Array) => void) {
        if (isTauri()) {
            this.backendTauri!.addListener((msg) => {
                switch (msg.type) {
                    case "Text":
                        console.error("Network messages must be in binary!");
                        break;
                    case "Binary":
                        cb(Uint8Array.from(msg.data));
                        break;
                    case "Ping":
                        break;
                    case "Pong":
                        break;
                    case "Close":
                        break;
                }
            });
        } else {
            this.backendWeb!.addEventListener("message", (ev) => {
                console.log(ev.data);
                let data = ev.data as Blob;
                data.bytes().then(cb);
            })
        }
    }
}