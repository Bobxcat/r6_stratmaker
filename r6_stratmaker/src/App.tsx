import { useEffect, useState } from "react";
import reactLogo from "./assets/react.svg";
import { invoke } from "@tauri-apps/api/core";
import WebSocket from "@tauri-apps/plugin-websocket";
import "./App.css";

enum DrawTool {
  FreeDraw,
  Arrow,
}

class FreeDrawCanvasState {
  mouseX: number = 0;
  mouseY: number = 0;
  prevMouseClicked: boolean = false;
  mouseClicked: boolean = false;
  paths: Array<DrawPath> = [];

  private static _instance: FreeDrawCanvasState;

  private constructor() { }

  public static get Instance() {
    // Do you need arguments? Make it a regular static method instead.
    return this._instance || (this._instance = new this());
  }
}

class Vec2 {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  magnitude(): number {
    return this.x * this.x + this.y * this.y;
  }

  distance(other: Vec2): number {
    return new Vec2(other.x - this.y, other.y - this.y).magnitude();
  }
}

class DrawPath {
  points: Array<Vec2> = [];
}

const freeDrawCanvasState = FreeDrawCanvasState.Instance;

function App() {
  const [websocket, setWebsocket] = useState<WebSocket | undefined>(undefined);
  const [currMap, setCurrMap] = useState<string>("");
  // const [currMapImg, setCurrMapImg] = useState<string>("");
  const [currMapWidth, setCurrMapWidth] = useState<number>(1600);
  const [currMapHeight, setCurrMapHeight] = useState<number>(900);
  const [currMapFloors, setCurrMapFloors] = useState<Array<string>>([]);
  const [currMapSelectedFloor, setCurrMapSelectedFloor] = useState<number>(0);

  const [currDrawTool, setCurrDrawTool] = useState<DrawTool>(DrawTool.FreeDraw);

  function println(msg: string) {
    invoke("console_println", { msg })
  }

  function getFloorImgPath(map: string, floor: string): string {
    return `/maps/${map}/${floor}.jpg`
  }

  async function handleNetworkMessage(msgRaw: string) {
    println(msgRaw);
    const msg = JSON.parse(msgRaw);
    println(msg.img_path);
    switch (msg.message_type) {
      case "set_active_map":
        setCurrMap(msg.map_name);
        setCurrMapFloors(msg.floors);
        break;
      default:
        break;
    }
  }

  function freeDrawCanvas() {
    function mousePosForCanvas(canvasId: string, clientX: number, clientY: number): Vec2 {
      const canvas = document.getElementById(canvasId)! as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return new Vec2(((clientX - rect.left) * scaleX), ((clientY - rect.top) * scaleY));
    }

    function redrawCanvas() {
      const canvas = document.getElementById("map-drawing-canvas")! as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      freeDrawCanvasState.paths.forEach((path) => {
        ctx.beginPath();

        path.points.forEach((pt, idx) => {
          if (idx == 0) {
            ctx.moveTo(pt.x, pt.y);
          } else {
            ctx.lineTo(pt.x, pt.y);
          }
        });

        ctx.stroke();
        ctx.closePath();
      })
    }

    function triggerUndo() {
      if (freeDrawCanvasState.paths.length > 0) {
        println("Undoing!!");
        freeDrawCanvasState.paths.pop();
        redrawCanvas();
      }
    }

    document.onkeydown = (e) => {
      e.preventDefault();
      if (e.ctrlKey && e.key == "z") {
        triggerUndo();
      }
    };

    // TODO: Split into multiple canvas instances, so that free-drawing has managable overhead
    // (how to sync free-draw state between clients?)
    // - https://stackoverflow.com/questions/3008635/html5-canvas-element-multiple-layers
    // NOTE: In the final product, free-draw is intended to be done in-game (real-time and temporary)
    // over top of an existing strategy (possibly with free-drawing already
    // baked in, but saved seperately and done out-of-game)
    // * In-game features:
    // - Select floor locally, display as layers (each floor is a separate canvas?)

    return (
      <canvas id="map-drawing-canvas"
        style={{ gridColumn: 1, gridRow: 1, zIndex: 1 }}
        width={currMapWidth}
        height={currMapHeight}
        onMouseEnter={(e) => freeDrawCanvasState.mouseClicked = false}
        onMouseLeave={(e) => freeDrawCanvasState.mouseClicked = false}
        onMouseDown={(e) => freeDrawCanvasState.mouseClicked = true}
        onMouseUp={(e) => freeDrawCanvasState.mouseClicked = false}
        onMouseMove={(e) => {
          const canvas = document.getElementById("map-drawing-canvas")! as HTMLCanvasElement;
          const ctx = canvas.getContext("2d")!;

          const prevMouseX = freeDrawCanvasState.mouseX;
          const prevMouseY = freeDrawCanvasState.mouseY;
          const mousePos = mousePosForCanvas("map-drawing-canvas", e.clientX, e.clientY);

          freeDrawCanvasState.mouseX = mousePos.x;
          freeDrawCanvasState.mouseY = mousePos.y;

          if (currDrawTool == DrawTool.FreeDraw && freeDrawCanvasState.mouseClicked) {
            if (freeDrawCanvasState.paths.length > 0 && freeDrawCanvasState.prevMouseClicked) {
              // Continue existing path
              freeDrawCanvasState.paths[freeDrawCanvasState.paths.length - 1].points.push(mousePos);
            } else {
              // Create new path
              var path = new DrawPath();
              path.points.push(mousePos);
              freeDrawCanvasState.paths.push(path);
            }

            if (freeDrawCanvasState.prevMouseClicked) {
              ctx.beginPath();
              ctx.strokeStyle = "red";
              ctx.lineWidth = 3;

              ctx.moveTo(prevMouseX, prevMouseY);
              ctx.lineTo(freeDrawCanvasState.mouseX, freeDrawCanvasState.mouseY);

              ctx.stroke();
              ctx.closePath();
            }
          }


          freeDrawCanvasState.prevMouseClicked = freeDrawCanvasState.mouseClicked;
        }}
      >
      </canvas>
    )
  }

  useEffect(() => {
    // This runs twice in dev mode:
    // https://react.dev/learn/lifecycle-of-reactive-effects#how-react-verifies-that-your-effect-can-re-synchronize
    async function initWebsocket() {
      let ws = await WebSocket.connect('ws://127.0.0.1:8080');

      ws.addListener((msg) => {
        handleNetworkMessage(msg.data!.toString());
      });
      ws.send(JSON.stringify({ message_type: "hello" }));

      setWebsocket(ws);

      setTimeout(() => {
        const canvas = document.getElementById("map-drawing-canvas") as HTMLCanvasElement;
        const ctx: CanvasRenderingContext2D = canvas.getContext("2d")!;
        const img = document.getElementById("fooimg") as HTMLImageElement;
        ctx.drawImage(img, 0, 0, 200, 200)
      }, 1000)

    }

    initWebsocket();
  }, [])


  return (
    <main className="container">
      <p>Current Floor: {currMapFloors[currMapSelectedFloor]}</p>

      <div className="row">
        {currMapFloors.map((floor_name, i) =>
          <button onClick={(e) => {
            e.preventDefault();
            setCurrMapSelectedFloor(i);
          }}>{floor_name}</button>
        )}
      </div>

      <div className="row" style={{ justifyItems: "left" }}>
        <div className="col" id="tool-selector-bar">
          <button onClick={(e) => { setCurrDrawTool(DrawTool.FreeDraw) }}>FreeDraw</button>
          <button onClick={(e) => { setCurrDrawTool(DrawTool.Arrow) }}>Arrow</button>
          <button onClick={(e) => { setCurrDrawTool(DrawTool.FreeDraw) }}>PlaceOperator</button>
        </div>
        <div id="draw-area" style={{ display: "grid", gridTemplateColumns: "1", gridTemplateRows: "1" }}>
          <img src={getFloorImgPath(currMap, currMapFloors[currMapSelectedFloor])}
            style={{ gridColumn: 1, gridRow: 1, zIndex: 0 }} />
          {freeDrawCanvas()}
        </div>
      </div>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();

        }}>
        <input
          id="select-map-text-input"
          onChange={(e) => { }}
          placeholder="Put the map here!"
        />
        <button type="submit">Set Current Map</button>
      </form>

    </main >
  );
}

export default App;
