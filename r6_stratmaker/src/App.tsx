import { useEffect, useReducer, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import WebSocket from "@tauri-apps/plugin-websocket";
import MessageKind from "@tauri-apps/plugin-websocket";
import "./App.css";
import * as protos from "./generated_protos/primary"

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

class StratEditingPhase {
  phaseName: string = "---";
}

class StratEditingState {
  stratId: string = "";
  stratName: string = "";
  map: string = "";
  mapFloors: string[] = [];
  mapImgWidth: number = 1600;
  mapImgHeight: number = 900;
  selectedFloor: number = 0;

  phases: StratEditingPhase[] = [];
  selectedPhase: number = 0;
}

class StratEditingDisplayPhase {
  phaseName: string = "";
}

/** This contains a subset of `StratEditingState` to be used as reactive state for the UI.
 * In order to modify this state, always edit `StratEditingState` and call `updateStratEditingStateDisplay()`
 */
class StratEditingStateDisplay {
  stratName: string = "";
  map: string = "";
  mapFloors: string[] = [];
  mapImgWidth: number = 1600;
  mapImgHeight: number = 900;
  activeFloor: number = 0;

  phases: StratEditingDisplayPhase[] = [];
  selectedPhase: number = 0;
}

const stratEditingState = new StratEditingState();

const freeDrawCanvasState = FreeDrawCanvasState.Instance;


const mapList = ["chalet", "coastline"];

var websocket: WebSocket | null = null;

function App() {
  const [stratEditingStateDisplay, setStratEditingStateDisplay] = useState<StratEditingStateDisplay>(new StratEditingStateDisplay());

  const [currPage, setCurrPage] = useState<Page>(Page.ConnectToServerPage);

  const [stratList, setStratList] = useState<Array<StratMetadata>>([]);

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

  function updateStratEditingStateDisplay() {
    const newDisplayState: StratEditingStateDisplay = {
      stratName: stratEditingState.stratName,
      map: stratEditingState.map,
      mapFloors: stratEditingState.mapFloors,
      activeFloor: stratEditingState.selectedFloor,
      mapImgWidth: stratEditingState.mapImgWidth,
      mapImgHeight: stratEditingState.mapImgHeight,
      phases: stratEditingState.phases.map((phase) => { return { phaseName: phase.phaseName } }),
      selectedPhase: stratEditingState.selectedPhase,
    };
    setStratEditingStateDisplay(newDisplayState);
  }

  async function sendNetworkMessage(msg: protos.Client2Server) {
    const msgRaw = protos.Client2Server.encode(msg).finish();
    await websocket?.send(Array.from(msgRaw));
  }

  async function handleNetworkMessage(msgRaw: Uint8Array) {
    const msg = protos.Server2Client.decode(msgRaw);

    println(`Received Message: ${JSON.stringify(msg)}`);

    if (msg.helloResponse) {
      setCurrPage(Page.LoginPage);
    } else if (msg.loginResponse) {
      setCurrPage(Page.StratListPage);
      sendNetworkMessage(protos.Client2Server.create({ getStratList: {} }));
    } else if (msg.getStratListResponse) {
      var newStratList: Array<StratMetadata> = [];
      msg.getStratListResponse.strats.forEach((strat) => {
        newStratList.push(new StratMetadata(strat.stratId, strat.stratName, strat.map));
      });
      setStratList(newStratList);
    } else if (msg.createEmptyStratResponse) {
      stratEditingState.stratId = msg.createEmptyStratResponse.stratId;
      setCurrPage(Page.StratEditorPage);
    } else if (msg.getMapMetadataResponse) {
      stratEditingState.selectedFloor = 0;
      stratEditingState.mapFloors = msg.getMapMetadataResponse.floors;
      updateStratEditingStateDisplay();
    } else if (msg.getStratInfoResponse) {
      //
    } else if (msg.saveStratResponse) {
      //
    } else {
      println(`  Unhandled message!!!`);
    }
  }

  function connectToServerPageComponent() {
    async function connectToServer(ipAddr: string) {
      let ws = await WebSocket.connect(`ws://${ipAddr}`);
      websocket = ws;

      ws.addListener((msg) => {
        switch (msg.type) {
          case "Text":
            println("Network messages must be in binary!");
            break;
          case "Binary":
            handleNetworkMessage(Uint8Array.from(msg.data));
            break;
          case "Ping":
            break;
          case "Pong":
            break;
          case "Close":
            break;
        }
      });
      await sendNetworkMessage(protos.Client2Server.create({ hello: {} }));

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
      sendNetworkMessage(protos.Client2Server.create({ loginRequest: { username } }))
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
    async function loadStrat(stratMeta: StratMetadata) {
      stratEditingState.map = stratMeta.map;
      updateStratEditingStateDisplay();
      await sendNetworkMessage(protos.Client2Server.create({ getStratInfo: { stratId: stratMeta.uuid } }));
      await sendNetworkMessage(protos.Client2Server.create({ getMapMetadata: { map: stratMeta.map } }));
    }

    return (<>
      <p>List of strats!</p>
      <button onClick={(_) => {
        setCurrPage(Page.CreateNewStratMapSelectionPage);
      }}>Create New Strat</button>
      {stratList.map((stratMeta) =>
        <div className="strat-list-strat-container">
          <p>{stratMeta.strat_name}</p>
          <p>{stratMeta.map}</p>
          <button onClick={(_) => {
            loadStrat(stratMeta);
            println("TODO: GET STRAT INFO FROM SERVER AND LOAD!");
          }}>Edit</button>
        </div>
      )}
    </>)
  }

  function createNewStratMapSelectionPageComponent() {
    async function createNewStrat(map: string) {
      stratEditingState.map = map;
      updateStratEditingStateDisplay();
      await sendNetworkMessage(protos.Client2Server.create({ createEmptyStrat: { map } }));
      await sendNetworkMessage(protos.Client2Server.create({ getMapMetadata: { map } }));
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
          width={stratEditingStateDisplay.mapImgWidth}
          height={stratEditingStateDisplay.mapImgHeight}
          onMouseEnter={(_e) => freeDrawCanvasState.mouseClicked = false}
          onMouseLeave={(_e) => freeDrawCanvasState.mouseClicked = false}
          onMouseDown={(_e) => freeDrawCanvasState.mouseClicked = true}
          onMouseUp={(_e) => freeDrawCanvasState.mouseClicked = false}
          onMouseMove={(e) => {
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
                var path = new DrawPath();
                path.points = [new Vec2(prevMouseX, prevMouseY), new Vec2(freeDrawCanvasState.mouseX, freeDrawCanvasState.mouseY)];
                drawPathToCanvas("map-drawing-canvas", path);
              }
            }

            freeDrawCanvasState.prevMouseClicked = freeDrawCanvasState.mouseClicked;
          }}
        >
        </canvas>
      )
    }

    async function saveProgress() {
      const paths: protos.FreeDrawPath[] = freeDrawCanvasState.paths.map((path) =>
        protos.FreeDrawPath.create({
          points:
            path.points.map((pt) =>
              protos.Point.create({ x: pt.x, y: pt.y })
            )
        })
      );
      println("TODO SAVE!");
      // const state: protos.StratState = { stratName: "My cool strat!", phases: {} }
      // await sendNetworkMessage(protos.Client2Server.create({ saveStrat: { stratId: currStratId, state: state } }));
    }

    return (
      <>
        <button onClick={(_) => {
          saveProgress().then((_) => {
            setCurrPage(Page.StratListPage);
          });
        }}>Back to Strat list</button>

        <button onClick={(_) => {
          saveProgress()
        }}>Save Progress</button>

        <p>Current Phase: {stratEditingStateDisplay.phases[stratEditingStateDisplay.selectedPhase]?.phaseName}</p>
        <div className="row">
          {stratEditingStateDisplay.phases.map((phase, i) =>
            <button onClick={(e) => {
              e.preventDefault();
              stratEditingState.selectedPhase = i;
              updateStratEditingStateDisplay();
            }}>{phase.phaseName}</button>
          )}
          <button onClick={(e) => {
            e.preventDefault();
            stratEditingState.phases.push(new StratEditingPhase());
            updateStratEditingStateDisplay();
          }}>Create new phase</button>
        </div>

        <p>Current Floor: {stratEditingStateDisplay.mapFloors[stratEditingStateDisplay.activeFloor]}</p>
        <div className="row">
          {stratEditingStateDisplay.mapFloors.map((floor_name, i) =>
            <button onClick={(e) => {
              e.preventDefault();
              stratEditingState.selectedFloor = i;
              updateStratEditingStateDisplay();
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
            <img src={getFloorImgPath(stratEditingStateDisplay.map, stratEditingStateDisplay.mapFloors[stratEditingStateDisplay.activeFloor])}
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
