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
  PlaceIcon,
}

class FreeDrawCanvasState {
  prevMousePos: Vec2 = new Vec2(0, 0);
  mousePos: Vec2 = new Vec2(0, 0);

  prevMouseClicked: boolean = false;
  mouseClicked: boolean = false;

  arrowHasBeenStarted: boolean = false;
  arrowStartPoint: Vec2 = new Vec2(0, 0);

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

  clone(): Vec2 {
    return new Vec2(this.x, this.y);
  }

  sqrMagnitude(): number {
    return this.x * this.x + this.y * this.y;
  }

  magnitude(): number {
    return Math.sqrt(this.sqrMagnitude());
  }

  distance(other: Vec2): number {
    return new Vec2(other.x - this.y, other.y - this.y).magnitude();
  }

  normalized(): Vec2 {
    return this.clone().scaled(1 / this.magnitude());
  }

  rotated(angle: number): Vec2 {
    const cosa = Math.cos(angle);
    const sina = Math.sin(angle);
    return new Vec2(this.x * cosa - this.y * sina, this.x * sina + this.y * cosa);
  }

  scaled(scale: number): Vec2 {
    return new Vec2(this.x * scale, this.y * scale);
  }

  add(rhs: Vec2): Vec2 {
    return new Vec2(this.x + rhs.x, this.y + rhs.y);
  }

  sub(rhs: Vec2): Vec2 {
    return new Vec2(this.x - rhs.x, this.y - rhs.y);
  }
}

class DrawPath {
  points: Array<Vec2> = [];
}

class Arrow {
  start: Vec2;
  end: Vec2;
  constructor(start: Vec2, end: Vec2) {
    this.start = start;
    this.end = end;
  }
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

class StratEditingPhaseFloor {
  freeDrawPaths: DrawPath[] = [];
  arrows: Arrow[] = [];
}

class StratEditingPhase {
  phaseName: string = "---";
  floors: StratEditingPhaseFloor[] = [];
}

class StratEditingState {
  selectedDrawTool: DrawTool = DrawTool.FreeDraw;

  stratId: string = "";
  stratName: string = "";
  map: string = "";
  mapFloors: string[] = [];
  mapImgWidth: number = 1600;
  mapImgHeight: number = 900;
  selectedFloor: number = 0;

  phases: StratEditingPhase[] = [];
  selectedPhase: number = 0;

  pushEmptyPhase() {
    var phase = new StratEditingPhase();
    phase.phaseName = `Phase ${this.phases.length}`;
    phase.floors = this.mapFloors.map((_floorName) => new StratEditingPhaseFloor());
    this.phases.push(phase);
  }

  currentPhaseFloor(): StratEditingPhaseFloor | null {
    return this.phases[this.selectedPhase]?.floors[this.selectedFloor];
  }
}

class StratEditingDisplayPhase {
  phaseName: string = "";
}

/** This contains a subset of `StratEditingState` to be used as reactive state for the UI.
 * In order to modify this state, always edit `StratEditingState` and call `updateStratEditingStateDisplay()`
 */
class StratEditingStateDisplay {
  selectedDrawTool: DrawTool = DrawTool.FreeDraw;

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

const stratEditorFreeDrawCanvasId = "strat-editor-free-draw-canvas";

const mapList = ["chalet", "coastline"];

var websocket: WebSocket | null = null;

function App() {
  const [stratEditingStateDisplay, setStratEditingStateDisplay] = useState<StratEditingStateDisplay>(new StratEditingStateDisplay());

  const [currPage, setCurrPage] = useState<Page>(Page.ConnectToServerPage);

  const [stratList, setStratList] = useState<Array<StratMetadata>>([]);

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
      selectedDrawTool: stratEditingState.selectedDrawTool,
      stratName: stratEditingState.stratName,
      map: stratEditingState.map,
      mapFloors: stratEditingState.mapFloors,
      activeFloor: stratEditingState.selectedFloor,
      mapImgWidth: stratEditingState.mapImgWidth,
      mapImgHeight: stratEditingState.mapImgHeight,
      phases: stratEditingState.phases.map((phase) => { return { phaseName: phase.phaseName }; }),
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
        <div key={stratMeta.uuid} className="strat-list-strat-container">
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
          <div key={mapName} className="col">
            <button onClick={(_) => { createNewStrat(mapName) }}>{mapName}</button>
          </div>
        )}
      </div>
    </>)
  }

  function stratEditorPageComponent() {
    const arrowPlacementPreviewCanvasId = "arrow-placement-preview-canvas";

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

    function drawArrowToCanvas(canvasId: string, arrow: Arrow) {
      const canvas = document.getElementById(canvasId);
      if (canvas == null) {
        return;
      }

      const ctx = (canvas as HTMLCanvasElement).getContext("2d");
      if (ctx == null) {
        return;
      }

      ctx.beginPath();
      ctx.strokeStyle = "blue";
      ctx.lineWidth = 3;

      ctx.moveTo(arrow.start.x, arrow.start.y);
      ctx.lineTo(arrow.end.x, arrow.end.y);

      const makeArrowHeadPoint = (side: boolean, isFixedLength: boolean, fixedLength: number): Vec2 => {
        var rot = side ? 0.1 : -0.1;
        var a = arrow.end.sub(arrow.start).rotated(rot).scaled(0.9).add(arrow.start);
        if (isFixedLength) {
          a = a.sub(arrow.end).normalized().scaled(fixedLength).add(arrow.end);
        }

        return a;
      };

      const arrowHeadPt0 = makeArrowHeadPoint(true, true, 10);
      const arrowHeadPt1 = makeArrowHeadPoint(false, true, 10);

      ctx.moveTo(arrowHeadPt0.x, arrowHeadPt0.y);
      ctx.lineTo(arrow.end.x, arrow.end.y)
      ctx.lineTo(arrowHeadPt1.x, arrowHeadPt1.y);

      ctx.stroke();
      ctx.closePath();
    }

    function redrawFreeDrawCanvas(canvasId: string) {
      const canvas = document.getElementById(canvasId)! as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const phaseFloor = stratEditingState.currentPhaseFloor();
      if (phaseFloor) {
        phaseFloor.freeDrawPaths.forEach((path) => {
          drawPathToCanvas(canvasId, path);
        });
        phaseFloor.arrows.forEach((arrow) => {
          drawArrowToCanvas(canvasId, arrow);
        });
      }
    }

    function mousePosForCanvas(canvasId: string, clientX: number, clientY: number): Vec2 {
      const canvas = document.getElementById(canvasId)! as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return new Vec2(((clientX - rect.left) * scaleX), ((clientY - rect.top) * scaleY));
    }

    function freeDrawCanvas(canvasId: string) {
      return (
        <canvas id={canvasId}
          style={{ gridColumn: 1, gridRow: 1, zIndex: 1 }}
          width={stratEditingStateDisplay.mapImgWidth}
          height={stratEditingStateDisplay.mapImgHeight}
        >
        </canvas>
      )
    }

    function inputGatheringCanvas() {
      const inputGatheringCanvasId = "input-gathering-canvas";

      function onUpdate() {
        const phaseFloor = stratEditingState.currentPhaseFloor();

        if (!phaseFloor) {
          return;
        }

        switch (stratEditingState.selectedDrawTool) {
          case DrawTool.FreeDraw:
            if (freeDrawCanvasState.mouseClicked) {
              if (phaseFloor.freeDrawPaths.length > 0 && freeDrawCanvasState.prevMouseClicked) {
                // Continue existing path
                phaseFloor.freeDrawPaths[phaseFloor.freeDrawPaths.length - 1].points.push(freeDrawCanvasState.mousePos.clone());
              } else {
                // Create new path
                var path = new DrawPath();
                path.points.push(freeDrawCanvasState.mousePos.clone());
                phaseFloor.freeDrawPaths.push(path);
              }

              if (freeDrawCanvasState.prevMouseClicked) {
                var path = new DrawPath();
                path.points = [freeDrawCanvasState.prevMousePos.clone(), freeDrawCanvasState.mousePos.clone()];
                drawPathToCanvas(stratEditorFreeDrawCanvasId, path);
              }
            }
            break;
          case DrawTool.Arrow:
            if (freeDrawCanvasState.mouseClicked && !freeDrawCanvasState.prevMouseClicked) {
              if (freeDrawCanvasState.arrowHasBeenStarted) {
                const arrow = new Arrow(freeDrawCanvasState.arrowStartPoint.clone(), freeDrawCanvasState.mousePos.clone());
                drawArrowToCanvas(stratEditorFreeDrawCanvasId, arrow);
                phaseFloor.arrows.push(arrow);
                freeDrawCanvasState.arrowHasBeenStarted = false;
              } else {
                freeDrawCanvasState.arrowStartPoint = freeDrawCanvasState.mousePos.clone();
                freeDrawCanvasState.arrowHasBeenStarted = true;
              }
            }

            const arrowPreviewCanvas = document.getElementById(arrowPlacementPreviewCanvasId)! as HTMLCanvasElement;
            const arrowPreviewCtx = arrowPreviewCanvas.getContext("2d")!;
            arrowPreviewCtx.clearRect(0, 0, arrowPreviewCanvas.width, arrowPreviewCanvas.height);
            if (freeDrawCanvasState.arrowHasBeenStarted && !freeDrawCanvasState.mouseClicked) {
              const arrow = new Arrow(freeDrawCanvasState.arrowStartPoint.clone(), freeDrawCanvasState.mousePos.clone());
              drawArrowToCanvas(arrowPlacementPreviewCanvasId, arrow);
            }
            break;
          case DrawTool.PlaceIcon:
            break;
        }

        freeDrawCanvasState.prevMouseClicked = freeDrawCanvasState.mouseClicked;
        freeDrawCanvasState.prevMousePos = freeDrawCanvasState.mousePos;

        requestAnimationFrame(onUpdate);
      }
      requestAnimationFrame(onUpdate);

      function triggerUndo() {
        const phaseFloor = stratEditingState.currentPhaseFloor();
        if (phaseFloor) {
          switch (stratEditingState.selectedDrawTool) {
            case DrawTool.FreeDraw:
              if (phaseFloor.freeDrawPaths.length > 0) {
                phaseFloor.freeDrawPaths.pop();
                redrawFreeDrawCanvas(stratEditorFreeDrawCanvasId);
              }
              break;
            case DrawTool.Arrow:
              if (phaseFloor.arrows.length > 0) {
                phaseFloor.arrows.pop();
                redrawFreeDrawCanvas(stratEditorFreeDrawCanvasId);
              }
              break;
            case DrawTool.PlaceIcon:
              break;
          }
        }
      }

      document.onkeydown = (e) => {
        if (e.ctrlKey && e.key == "z") {
          triggerUndo();
        }
      };

      return (<>
        <canvas id={inputGatheringCanvasId}
          style={{ gridColumn: 1, gridRow: 1, zIndex: 100 }}
          width={stratEditingStateDisplay.mapImgWidth}
          height={stratEditingStateDisplay.mapImgHeight}
          onMouseEnter={(_e) => freeDrawCanvasState.mouseClicked = false}
          onMouseLeave={(_e) => freeDrawCanvasState.mouseClicked = false}
          onMouseDown={(_e) => freeDrawCanvasState.mouseClicked = true}
          onMouseUp={(_e) => freeDrawCanvasState.mouseClicked = false}
          onMouseMove={(e) => {
            freeDrawCanvasState.mousePos = mousePosForCanvas(inputGatheringCanvasId, e.clientX, e.clientY);
          }}></canvas>
      </>)
    }

    async function saveProgress() {
      const phaseFloor = stratEditingState.currentPhaseFloor();
      // const paths: protos.FreeDrawPath[] = phaseFloor.paths.map((path) =>
      //   protos.FreeDrawPath.create({
      //     points:
      //       path.points.map((pt) =>
      //         protos.Point.create({ x: pt.x, y: pt.y })
      //       )
      //   })
      // );
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
            <button key={i} onClick={(e) => {
              e.preventDefault();
              stratEditingState.selectedPhase = i;
              redrawFreeDrawCanvas(stratEditorFreeDrawCanvasId);
              updateStratEditingStateDisplay();
            }}>{phase.phaseName}</button>
          )}
          <button onClick={(e) => {
            e.preventDefault();
            stratEditingState.pushEmptyPhase();
            updateStratEditingStateDisplay();
          }}>Create new phase</button>
        </div>

        <p>Current Floor: {stratEditingStateDisplay.mapFloors[stratEditingStateDisplay.activeFloor]}</p>
        <div className="row">
          {stratEditingStateDisplay.mapFloors.map((floor_name, i) =>
            <button key={i} onClick={(e) => {
              e.preventDefault();
              stratEditingState.selectedFloor = i;
              redrawFreeDrawCanvas(stratEditorFreeDrawCanvasId);
              updateStratEditingStateDisplay();
            }}>{floor_name}</button>
          )}
        </div>

        <div className="row" style={{ justifyItems: "left" }}>
          <div className="col" id="tool-selector-bar">
            <p>{DrawTool[stratEditingState.selectedDrawTool]}</p>
            <button onClick={(_) => { stratEditingState.selectedDrawTool = DrawTool.FreeDraw; updateStratEditingStateDisplay(); }}>FreeDraw</button>
            <button onClick={(_) => { stratEditingState.selectedDrawTool = DrawTool.Arrow; updateStratEditingStateDisplay(); }}>Arrow</button>
            <button onClick={(_) => { stratEditingState.selectedDrawTool = DrawTool.PlaceIcon; updateStratEditingStateDisplay(); }}>PlaceOperator</button>
          </div>
          <div id="draw-area" style={{ display: "grid", gridTemplateColumns: "1", gridTemplateRows: "1" }}>
            <img src={getFloorImgPath(stratEditingStateDisplay.map, stratEditingStateDisplay.mapFloors[stratEditingStateDisplay.activeFloor])}
              style={{ gridColumn: 1, gridRow: 1, zIndex: 0 }} />
            {freeDrawCanvas(stratEditorFreeDrawCanvasId)}
            <canvas id={arrowPlacementPreviewCanvasId}
              style={{ gridColumn: 1, gridRow: 1, zIndex: 2 }}
              width={stratEditingStateDisplay.mapImgWidth}
              height={stratEditingStateDisplay.mapImgHeight}></canvas>
            {inputGatheringCanvas()}
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
