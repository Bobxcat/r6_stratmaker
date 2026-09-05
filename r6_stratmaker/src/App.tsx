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

  private constructor() {
    //
  }

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
  points: Array<Vec2>;
  constructor() {
    this.points = [];
  }
}

const renderCanvasState = RenderCanvasState.Instance;

function App() {
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");
  const [websocket, setWebsocket] = useState<WebSocket | undefined>(undefined);
  const [currMap, setCurrMap] = useState<string>("");
  const [currMapImg, setCurrMapImg] = useState<string>("");
  const [currMapWidth, setCurrMapWidth] = useState<number>(1600);
  const [currMapHeight, setCurrMapHeight] = useState<number>(900);

  const [currFrameTime, setCurrFrameTime] = useState<string>("---");
  const [currFPS, setCurrFPS] = useState<string>("---");

  async function greet() {
    // Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
    setGreetMsg(await invoke("greet", { name }));
  }

  function println(msg: string) {
    invoke("console_println", { msg })
  }

  async function handleNetworkMessage(msgRaw: string) {
    println(msgRaw);
    const msg = JSON.parse(msgRaw);
    println(msg.img_path);
    switch (msg.message_type) {
      case "get_img_response":
        setCurrMap(msg.map_name);
        setCurrMapImg(msg.img_path);
        break;
      default:
        break;
    }
  }

  function MapDrawingMode() {

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
        if (currPath.points.length == 0 || currPath.points[currPath.points.length - 1].distance(mousePos) > 0.001) {
          currPath.points.push(mousePos);
        }
      } else {
        if (renderCanvasState.paths.length > 0 && renderCanvasState.paths[renderCanvasState.paths.length - 1].points.length <= 1) {
          renderCanvasState.paths.pop();
        }
      }

      // ----Render----
      const canvas = document.getElementById("map-drawing-canvas")! as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const mapImgElem = document.getElementById("fooimg")! as HTMLImageElement;

      ctx.drawImage(mapImgElem, 0, 0, currMapWidth, currMapHeight);

      renderCanvasState.paths.forEach(path => {
        if (path.points.length <= 1) {
          return;
        }

        ctx.beginPath();
        ctx.strokeStyle = "red";
        ctx.lineWidth = 3;

        path.points.forEach((value, idx, _array) => {
          if (idx == 0) {
            ctx.moveTo(value.x, value.y);
          } else {
            ctx.lineTo(value.x, value.y);
          }
        });


        ctx.stroke();
        ctx.closePath();
      });

      // ----Last----
      renderCanvasState.prevFrameTimeElapsed = timeElapsed;
      renderCanvasState.prevMouseClicked = renderCanvasState.mouseClicked;

      requestAnimationFrame(renderCanvas)
    }

    requestAnimationFrame(renderCanvas)

    return (
      <div>
        <h1>Map Editor</h1>
        <canvas id="map-drawing-canvas"
          width={currMapWidth}
          height={currMapHeight}
          onMouseEnter={(e) => renderCanvasState.mouseClicked = false}
          onMouseLeave={(e) => renderCanvasState.mouseClicked = false}
          onMouseDown={(e) => renderCanvasState.mouseClicked = true}
          onMouseUp={(e) => renderCanvasState.mouseClicked = false}
          onMouseMove={(e) => {
            const prevMouseX = renderCanvasState.mouseX;
            const prevMouseY = renderCanvasState.mouseY;
            updateMousePos(e.clientX, e.clientY);

            renderCanvasState.prevMouseClicked = renderCanvasState.mouseClicked;
          }}
        >
        </canvas>
      </div >
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
      ws.send(JSON.stringify({ message_type: "get_img" }));

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
      {MapDrawingMode()}


      <div className="row">
        <a>
          <img id="fooimg" src={currMapImg} className="current floor map" />
        </a>
      </div>
      <p>Click on the Tauri, Vite, and React logos to learn more.</p>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();

        }}>
        <input
          id="select-map-text-input"
          onChange={(e) => { }}
        />
        <button type="submit">Set Current Map</button>
      </form>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          greet();
        }}
      >
        <input
          id="greet-input"
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="Enter a name..."
        />
        <button type="submit">Greet</button>
      </form>
      <p>{greetMsg}</p>
      <p>Current map: {currMapImg}</p>
    </main>
  );
}

export default App;
