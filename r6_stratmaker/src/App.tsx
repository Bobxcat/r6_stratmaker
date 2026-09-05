import { useEffect, useState } from "react";
import reactLogo from "./assets/react.svg";
import { invoke } from "@tauri-apps/api/core";
import WebSocket from "@tauri-apps/plugin-websocket";
import "./App.css";


class RenderCanvasState {
  mouseX: number = 0;
  mouseY: number = 0;
  prevMouseClicked: boolean = false;
  mouseClicked: boolean = false;
  prevFrameTimeElapsed: number = 0;
  paths: Array<DrawPath> = [];

  private static _instance: RenderCanvasState;

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

const renderCanvasState = RenderCanvasState.Instance;

function App() {
  const [name, setName] = useState("");
  const [websocket, setWebsocket] = useState<WebSocket | undefined>(undefined);
  const [currMap, setCurrMap] = useState<string>("");
  // const [currMapImg, setCurrMapImg] = useState<string>("");
  const [currMapWidth, setCurrMapWidth] = useState<number>(1600);
  const [currMapHeight, setCurrMapHeight] = useState<number>(900);
  const [currMapFloors, setCurrMapFloors] = useState<Array<string>>([]);
  const [currMapSelectedFloor, setCurrMapSelectedFloor] = useState<number>(0);

  const [currFrameTime, setCurrFrameTime] = useState<string>("---");
  const [currFPS, setCurrFPS] = useState<string>("---");

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

  function MapDrawingLayer() {
    function updateMousePos(clientX: number, clientY: number) {
      const canvas = document.getElementById("map-drawing-canvas")! as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      renderCanvasState.mouseX = ((clientX - rect.left) * scaleX);
      renderCanvasState.mouseY = ((clientY - rect.top) * scaleY);
    }

    function renderCanvas(timeElapsed: number) {
      // ----PreUpdate----
      const frameDelta = timeElapsed - renderCanvasState.prevFrameTimeElapsed;

      // ----Update----
      setCurrFrameTime(frameDelta.toString());
      // setCurrFrameTime(frameDelta.toFixed(4) + "ms");
      setCurrFPS(frameDelta.toFixed(4));

      // Drawing
      if (renderCanvasState.mouseClicked) {
        if (renderCanvasState.paths.length == 0 || renderCanvasState.prevMouseClicked == false) {
          renderCanvasState.paths.push(new DrawPath());
        }
        const currPath = renderCanvasState.paths[renderCanvasState.paths.length - 1];
        const mousePos = new Vec2(renderCanvasState.mouseX, renderCanvasState.mouseY);
        if (currPath.points.length == 0 || currPath.points[currPath.points.length - 1].distance(mousePos) > 0.01) {
          currPath.points.push(mousePos);
        }
      } else {
        if (renderCanvasState.paths.length > 0 && renderCanvasState.paths[renderCanvasState.paths.length - 1].points.length <= 1) {
          renderCanvasState.paths.pop();
        }
      }

      // ----Render----
      // const canvas = document.getElementById("map-drawing-canvas")! as HTMLCanvasElement;
      // const ctx = canvas.getContext("2d")!;

      // ctx.clearRect(0, 0, canvas.width, canvas.height);

      // renderCanvasState.paths.forEach(path => {
      //   if (path.points.length <= 1) {
      //     return;
      //   }

      //   ctx.beginPath();
      //   ctx.strokeStyle = "red";
      //   ctx.lineWidth = 3;

      //   path.points.forEach((value, idx, _array) => {
      //     if (idx == 0) {
      //       ctx.moveTo(value.x, value.y);
      //     } else {
      //       ctx.lineTo(value.x, value.y);
      //     }
      //   });


      //   ctx.stroke();
      //   ctx.closePath();
      // });

      // ----Last----
      renderCanvasState.prevFrameTimeElapsed = timeElapsed;
      // renderCanvasState.prevMouseClicked = renderCanvasState.mouseClicked;

      requestAnimationFrame(renderCanvas)
    }

    requestAnimationFrame(renderCanvas)

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
        onMouseEnter={(e) => renderCanvasState.mouseClicked = false}
        onMouseLeave={(e) => renderCanvasState.mouseClicked = false}
        onMouseDown={(e) => renderCanvasState.mouseClicked = true}
        onMouseUp={(e) => renderCanvasState.mouseClicked = false}
        onMouseMove={(e) => {
          const canvas = document.getElementById("map-drawing-canvas")! as HTMLCanvasElement;
          const ctx = canvas.getContext("2d")!;

          const prevMouseX = renderCanvasState.mouseX;
          const prevMouseY = renderCanvasState.mouseY;
          updateMousePos(e.clientX, e.clientY);

          if (renderCanvasState.mouseClicked && renderCanvasState.prevMouseClicked) {
            ctx.beginPath();
            ctx.strokeStyle = "red";
            ctx.lineWidth = 3;

            ctx.moveTo(prevMouseX, prevMouseY);
            ctx.lineTo(renderCanvasState.mouseX, renderCanvasState.mouseY);

            ctx.stroke();
            ctx.closePath();
          }


          renderCanvasState.prevMouseClicked = renderCanvasState.mouseClicked;
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
      <p>Canvas FPS: {currFPS} / Frame Time: {currFrameTime}</p>

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
          <button>FreeDraw</button>
          <button>Arrow</button>
          <button>PlaceOperator</button>
        </div>
        <div id="draw-area" style={{ display: "grid", gridTemplateColumns: "1", gridTemplateRows: "1" }}>
          <img src={getFloorImgPath(currMap, currMapFloors[currMapSelectedFloor])}
            style={{ gridColumn: 1, gridRow: 1, zIndex: 0 }} />
          {MapDrawingLayer()}
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
