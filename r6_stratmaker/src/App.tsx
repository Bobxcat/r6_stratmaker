import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import WebSocket from "@tauri-apps/plugin-websocket";
import "./App.css";

enum Page {
  ConnectToServerPage,
  LoginPage,
  StratListPage,
  CreateNewStratMapSelectionPage,
  StratEditorPage,
}

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
  pathsForeign: Array<DrawPath> = [];
  networkedDrawCommandsQueue: Array<DrawPath> = [];

  private static _instance: FreeDrawCanvasState;

  private constructor() { }

  public static get Instance() {
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

class StratMetadata {
  uuid: string;
  strat_name: string;
  map: string;
  constructor(uuid: string, strat_name: string, map: string) {
    this.uuid = uuid;
    this.strat_name = strat_name;
    this.map = map;
  }
}

const freeDrawCanvasState = FreeDrawCanvasState.Instance;

const mapList = ["chalet", "coastline"];

function App() {
  const [currPage, setCurrPage] = useState<Page>(Page.ConnectToServerPage);

  const [stratList, setStratList] = useState<Array<StratMetadata>>([]);

  const [currStratId, setCurrStratId] = useState<string>("");

  const [websocket, setWebsocket] = useState<WebSocket | undefined>(undefined);
  const [currMap, setCurrMap] = useState<string>("");
  const [currMapWidth, setCurrMapWidth] = useState<number>(1600);
  const [currMapHeight, setCurrMapHeight] = useState<number>(900);
  const [currMapFloors, setCurrMapFloors] = useState<Array<string>>([]);
  const [currMapSelectedFloor, setCurrMapSelectedFloor] = useState<number>(0);

  const [currDrawTool, setCurrDrawTool] = useState<DrawTool>(DrawTool.FreeDraw);

  enum ConnectionState {
    WaitingForIP = "Waiting for IP Address (or Connection Failed)",
    Connecting = "Connecting to Server...",
    Connected = "Connected"
  }

  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.WaitingForIP);

  function println(msg: string) {
    invoke("console_println", { msg })
  }

  function getFloorImgPath(map: string, floor: string): string {
    return `/maps/${map}/${floor}.jpg`
  }

  async function handleNetworkMessage(msgRaw: string) {
    println(msgRaw);
    const msg = JSON.parse(msgRaw);
    switch (msg.message_type) {
      case "hello_response":
        setCurrPage(Page.LoginPage);
        break;
      case "login_response":
        setCurrPage(Page.StratListPage);
        break;
      case "get_strat_list_response":
        var newStratList: Array<StratMetadata> = []
        msg.strats.forEach((strat: any) => {
          newStratList.push(new StratMetadata(strat.strat_id, strat.strat_name, strat.map));
        });
        setStratList(newStratList);
        break;
      case "create_empty_strat_response":
        setCurrStratId(msg.strat_id);
        break;
      case "set_active_map":
        setCurrMap(msg.map_name);
        setCurrMapFloors(msg.floors);
        break;
      case "freedraw_line":
        freeDrawCanvasState.networkedDrawCommandsQueue.push({ points: [new Vec2(msg.from_x, msg.from_y), new Vec2(msg.to_x, msg.to_y)] });
        break;
      default:
        break;
    }
  }

  function connectToServerPageComponent() {
    async function connectToServer(ipAddr: string) {
      let ws = await WebSocket.connect(`ws://${ipAddr}`);

      ws.addListener((msg) => {
        handleNetworkMessage(msg.data!.toString());
      });
      ws.send(JSON.stringify({ message_type: "hello" }));

      setWebsocket(ws);
      setConnectionState(ConnectionState.Connected);
    }

    return (<>
      <p>{connectionState}</p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const ipAddrInput = document.getElementById("select-server-ip-address")! as HTMLInputElement;
          connectToServer(ipAddrInput.value);
          setConnectionState(ConnectionState.Connecting);
        }}>
        <input
          id="select-server-ip-address"
          defaultValue="127.0.0.1:8080"
        />
        <button type="submit">Connect</button>
      </form>
    </ >
    );
  }

  function loginPageComponent() {
    function commenceLogin(username: string) {
      websocket!.send(JSON.stringify({ message_type: "login_request", username: username }))
    }

    return (<>
      <p>Login</p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const usernameInput = document.getElementById("select-username")! as HTMLInputElement;
          commenceLogin(usernameInput.value)
        }}>
        <input
          id="select-username"
          placeholder="username"
          defaultValue="foo"
        />
        <button type="submit">Login</button>
      </form>
    </>)
  }

  function stratListPageComponent() {
    return (<>
      <p>List of strats!</p>
      <button onClick={(_) => {
        setCurrPage(Page.CreateNewStratMapSelectionPage);
      }}>Create New Strat</button>
      {stratList.map((stratMeta) =>
        <div className="col">
          <p>{stratMeta.strat_name}</p>
          <p>{stratMeta.map}</p>
        </div>
      )}
    </>)
  }

  function createNewStratMapSelectionPageComponent() {
    async function createNewStrat(map: string) {
      websocket?.send(JSON.stringify({ message_type: "create_empty_strat", map: map }))
    }

    return (<>
      <p>Select a Map</p>
      <button onClick={(_) => { setCurrPage(Page.StratListPage) }}>Cancel Create Strat</button>
      <div className="row">
        {mapList.map((mapName) =>
          <div className="col">
            <button onClick={(_) => { createNewStrat(mapName) }}>{mapName}</button>
          </div>
        )}
      </div>
    </>)
  }

  function stratEditorPageComponent() {
    function freeDrawCanvas() {
      function mousePosForCanvas(canvasId: string, clientX: number, clientY: number): Vec2 {
        const canvas = document.getElementById(canvasId)! as HTMLCanvasElement;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        return new Vec2(((clientX - rect.left) * scaleX), ((clientY - rect.top) * scaleY));
      }

      function drawPathToCanvas(canvasId: string, path: DrawPath) {
        const canvas = document.getElementById(canvasId);
        if (canvas == null) {
          return;
        }

        const ctx = (canvas as HTMLCanvasElement).getContext("2d");
        if (ctx == null) {
          return;
        }

        ctx.beginPath();
        ctx.strokeStyle = "red";
        ctx.lineWidth = 3;

        path.points.forEach((pt, idx) => {
          if (idx == 0) {
            ctx.moveTo(pt.x, pt.y);
          } else {
            ctx.lineTo(pt.x, pt.y);
          }
        });
        ctx.stroke();
        ctx.closePath();
      }

      function onCanvasUpdate(_timestamp: number) {
        requestAnimationFrame(onCanvasUpdate);

        freeDrawCanvasState.networkedDrawCommandsQueue.forEach((path) => {
          drawPathToCanvas("map-drawing-canvas", path);
          freeDrawCanvasState.pathsForeign.push(path);
        });
        freeDrawCanvasState.networkedDrawCommandsQueue = [];
      }
      requestAnimationFrame(onCanvasUpdate);

      function redrawCanvas() {
        const canvas = document.getElementById("map-drawing-canvas")! as HTMLCanvasElement;
        const ctx = canvas.getContext("2d")!;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        freeDrawCanvasState.paths.forEach((path) => {
          drawPathToCanvas("map-drawing-canvas", path);
        });
        freeDrawCanvasState.pathsForeign.forEach((path) => {
          drawPathToCanvas("map-drawing-canvas", path);
        });
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

      return (
        <canvas id="map-drawing-canvas"
          style={{ gridColumn: 1, gridRow: 1, zIndex: 1 }}
          width={currMapWidth}
          height={currMapHeight}
          onMouseEnter={(_e) => freeDrawCanvasState.mouseClicked = false}
          onMouseLeave={(_e) => freeDrawCanvasState.mouseClicked = false}
          onMouseDown={(_e) => freeDrawCanvasState.mouseClicked = true}
          onMouseUp={(_e) => freeDrawCanvasState.mouseClicked = false}
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

    return (
      <>
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
            <button onClick={(_) => { setCurrDrawTool(DrawTool.FreeDraw) }}>FreeDraw</button>
            <button onClick={(_) => { setCurrDrawTool(DrawTool.Arrow) }}>Arrow</button>
            <button onClick={(_) => { setCurrDrawTool(DrawTool.FreeDraw) }}>PlaceOperator</button>
          </div>
          <div id="draw-area" style={{ display: "grid", gridTemplateColumns: "1", gridTemplateRows: "1" }}>
            <img src={getFloorImgPath(currMap, currMapFloors[currMapSelectedFloor])}
              style={{ gridColumn: 1, gridRow: 1, zIndex: 0 }} />
            {freeDrawCanvas()}
          </div>
        </div>
      </>
    );
  }


  function currPageSelectorComponent(currPage: Page) {
    switch (currPage) {
      case Page.ConnectToServerPage:
        return connectToServerPageComponent()
      case Page.LoginPage:
        return loginPageComponent()
      case Page.StratListPage:
        return stratListPageComponent()
      case Page.CreateNewStratMapSelectionPage:
        return createNewStratMapSelectionPageComponent()
      case Page.StratEditorPage:
        return stratEditorPageComponent()
      default:
        return "ERROR: PAGE NOT Found"
    }
  }

  // User Experience:
  // - Open App
  // - Input the server's IP address
  // - Login?
  // - A page opens displaying all current strats, as well as an option for creating a new strat
  // - Option #1: You want to make or edit a strat
  //   * You either click "edit" on an existing listed strat or "create" and pick a map from the dropdown menu
  // - Option #2: You want to enter live stratmaking mode
  //   * You click a button that says "enter live-mode lobby"
  //   * 

  return (
    <main className="container">
      {currPageSelectorComponent(currPage)}
    </main >
  );
}

export default App;
