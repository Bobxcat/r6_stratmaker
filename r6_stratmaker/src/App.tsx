// Credit to https://github.com/marcopixel/r6operators for operator icons except Solid Snake
// Credit to RoseishDesigns on Etsy (https://www.etsy.com/listing/4387393681/derpy-snake-water-bottle-sticker-shnek) for the Solid Snake icon
// Credit to Ubisoft for map blueprints

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import WebSocket from "@tauri-apps/plugin-websocket";
import "./App.css";
import * as protos from "./generated_protos/primary"
import * as uuid from 'uuid';
import {
  stringifyCSSProperties,
  stringifyStyleMap,
} from "react-style-stringify";

class Uuid {
  readonly data: string;
  constructor() {
    this.data = uuid.v4();
  }
}

interface DrawElement {
  asEnum(): AnyDrawElementData;
  isHovered(mousePos: Vec2): boolean;
  boundingBox(): Aabb;
  drawToCtx(ctx: CanvasRenderingContext2D): void;
  mapPoints(map: (pt: Vec2) => Vec2): void;
}

enum DrawElementKind {
  DrawPath,
  Arrow,
  Icon,
}

type AnyDrawElementData =
  { kind: DrawElementKind.DrawPath, data: DrawPath } |
  { kind: DrawElementKind.Arrow, data: Arrow } |
  { kind: DrawElementKind.Icon, data: IconPlacement };

class AnyDrawElementId {
  kind: DrawElementKind;
  floor: number;
  id: Uuid;

  constructor(kind: DrawElementKind, floor: number, id: Uuid) {
    this.kind = kind;
    this.floor = floor;
    this.id = id;
  }

  get(phase: StratEditingPhase): DrawElement | undefined {
    const phaseFloor = phase.floors[this.floor];
    switch (this.kind) {
      case DrawElementKind.DrawPath: {
        return phaseFloor?.drawPaths.get(this.id);
      }
      case DrawElementKind.Arrow: {
        return phaseFloor?.arrows.get(this.id);
      }
      case DrawElementKind.Icon: {
        return phaseFloor?.icons.get(this.id);
      }
    }
  }

  equals(other: AnyDrawElementId): boolean {
    return (this.kind === other.kind)
      && (this.floor === other.floor)
      && (this.id === other.id);
  }

  clone(): AnyDrawElementId {
    return new AnyDrawElementId(this.kind, this.floor, this.id);
  }
}

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
  SelectAndEdit,
}

class InputCanvasState {
  prevMousePos: Vec2 = new Vec2(0, 0);
  mousePos: Vec2 = new Vec2(0, 0);

  prevMouseClicked: boolean = false;
  mouseClicked: boolean = false;

  private static _instance: InputCanvasState;

  private constructor() { }

  public static get Instance() {
    return this._instance || (this._instance = new this());
  }
}

class Vec2 {
  readonly x: number;
  readonly y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  toString(): string {
    return `(${this.x.toPrecision(4)},${this.y.toPrecision(4)})`;
  }

  clone(): Vec2 {
    return new Vec2(this.x, this.y);
  }

  dot(other: Vec2): number {
    return this.x * other.x + this.y * other.y;
  }

  sqrMagnitude(): number {
    return this.dot(this);
  }

  magnitude(): number {
    return Math.sqrt(this.sqrMagnitude());
  }

  distance(other: Vec2): number {
    return this.sub(other).magnitude();
  }

  normalized(): Vec2 {
    return this.clone().scaled(1.0 / this.magnitude());
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

  approxEq(other: Vec2): boolean {
    return this.distance(other) < 0.0001;
  }

  distanceToLine(lineStart: Vec2, lineEnd: Vec2, continuesForwards: boolean, continuesBackwards: boolean): DistanceToLineResult {
    if (lineStart.approxEq(lineEnd)) {
      return { distance: this.distance(lineStart), nearestPoint: lineStart };
    }

    const B = lineEnd.sub(lineStart);
    const P = this.sub(lineStart);

    const BOrth = new Vec2(-B.y, B.x).normalized();

    const signedDistance = P.dot(BOrth);

    let nearestPoint = P.sub(BOrth.scaled(signedDistance));

    const t = Math.abs(B.x) > Math.abs(B.y) ? nearestPoint.x / B.x : nearestPoint.y / B.y;

    if (t > 1 && !continuesForwards) {
      nearestPoint = B;
    } else if (t < 0 && !continuesBackwards) {
      nearestPoint = new Vec2(0, 0);
    }

    nearestPoint = nearestPoint.add(lineStart);

    return {
      distance: this.distance(nearestPoint),
      nearestPoint,
    };
  }
}

class DistanceToLineResult {
  distance: number = 0;
  nearestPoint: Vec2 = new Vec2(0, 0);
}

class Aabb {
  readonly minPt: Vec2 = new Vec2(0, 0);
  readonly maxPt: Vec2 = new Vec2(0, 0);

  static fromPoints(pts: Vec2[]): Aabb {
    const xs = pts.map((pt) => pt.x);
    const ys = pts.map((pt) => pt.y);

    return Object.assign(new Aabb(), {
      minPt: new Vec2(Math.min(...xs), Math.min(...ys)),
      maxPt: new Vec2(Math.max(...xs), Math.max(...ys)),
    });
  }

  width(): number {
    return this.maxPt.x - this.minPt.x;
  }

  height(): number {
    return this.maxPt.y - this.minPt.y;
  }

  containsPoint(pt: Vec2): boolean {
    return (this.minPt.x <= pt.x && pt.x <= this.maxPt.x) &&
      (this.minPt.y <= pt.y && pt.y <= this.maxPt.y);
  }
}

class DrawPath implements DrawElement {
  points: Array<Vec2> = [];

  asEnum(): AnyDrawElementData {
    return { kind: DrawElementKind.DrawPath, data: this };
  }
  isHovered(mousePos: Vec2): boolean {
    for (let i = 0; i < this.points.length - 1; i += 1) {
      const distToLine = mousePos.distanceToLine(this.points[i], this.points[i + 1], false, false).distance;
      if (distToLine < 5) {
        return true;
      }
    }
    return false;
  }
  boundingBox(): Aabb {
    return Aabb.fromPoints(this.points);
  }
  drawToCtx(ctx: CanvasRenderingContext2D): void {
    ctx.beginPath();
    ctx.strokeStyle = "red";
    ctx.lineWidth = 3;

    this.points.forEach((pt, idx) => {
      if (idx == 0) {
        ctx.moveTo(pt.x, pt.y);
      } else {
        ctx.lineTo(pt.x, pt.y);
      }
    });
    ctx.stroke();
    ctx.closePath();
  }
  mapPoints(map: (pt: Vec2) => Vec2): void {
    this.points = this.points.map(map)
  }
}

class Arrow implements DrawElement {
  start: Vec2;
  end: Vec2;
  constructor(start: Vec2, end: Vec2) {
    this.start = start;
    this.end = end;
  }

  asEnum(): AnyDrawElementData {
    return { kind: DrawElementKind.Arrow, data: this };
  }
  isHovered(mousePos: Vec2): boolean {
    return mousePos.distanceToLine(this.start, this.end, false, false).distance < 5;
  }
  boundingBox(): Aabb {
    return Aabb.fromPoints([this.start, this.end]);
  }
  drawToCtx(ctx: CanvasRenderingContext2D): void {
    ctx.beginPath();
    ctx.strokeStyle = "blue";
    ctx.lineWidth = 3;

    ctx.moveTo(this.start.x, this.start.y);
    ctx.lineTo(this.end.x, this.end.y);

    const makethisHeadPoint = (side: boolean, isFixedLength: boolean, fixedLength: number): Vec2 => {
      var rot = side ? 0.1 : -0.1;
      var a = this.end.sub(this.start).rotated(rot).scaled(0.9).add(this.start);
      if (isFixedLength) {
        a = a.sub(this.end).normalized().scaled(fixedLength).add(this.end);
      }

      return a;
    };

    const thisHeadPt0 = makethisHeadPoint(true, true, 10);
    const thisHeadPt1 = makethisHeadPoint(false, true, 10);

    ctx.moveTo(thisHeadPt0.x, thisHeadPt0.y);
    ctx.lineTo(this.end.x, this.end.y)
    ctx.lineTo(thisHeadPt1.x, thisHeadPt1.y);

    ctx.stroke();
    ctx.closePath();
  }
  mapPoints(map: (pt: Vec2) => Vec2): void {
    this.start = map(this.start);
    this.end = map(this.end);
  }

  toString(): string {
    return `(${this.start} -> ${this.end})`
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

enum IconKind {
  Operator,
  OperatorAbility,
}

class IconInfo {
  kind: IconKind = IconKind.Operator;
  teammateIndex: number = 0;
}

class IconPlacement implements DrawElement {
  pos: Vec2;
  size: number;
  info: IconInfo;
  constructor(pos: Vec2, size: number, info: IconInfo) {
    this.pos = pos;
    this.size = size;
    this.info = info;
  }

  asEnum(): AnyDrawElementData {
    return { kind: DrawElementKind.Icon, data: this };
  }
  isHovered(mousePos: Vec2): boolean {
    return this.boundingBox().containsPoint(mousePos);
  }
  boundingBox(): Aabb {
    var width = 0;
    var height = 0;

    const loadout = stratEditingState.teamLoadouts[this.info.teammateIndex];
    const opName = loadout.operator;
    switch (this.info.kind) {
      case IconKind.Operator: {
        width = this.size;
        height = this.size;
        break;
      }
      case IconKind.OperatorAbility: {
        height = this.size;
        const imgData = operatorsIndexNonReactive.abilityImgData.get(opName);
        const foo: HTMLImageElement = imgData! as HTMLImageElement;
        width = height * (foo.width / foo.height);
        break;
      }
    }

    return Aabb.fromPoints([this.pos, this.pos.add(new Vec2(width, height))]);
  }
  drawToCtx(ctx: CanvasRenderingContext2D): void {
    var imgData: CanvasImageSource | undefined;

    var aabb = this.boundingBox();

    const loadout = stratEditingState.teamLoadouts[this.info.teammateIndex];
    const opName = loadout.operator;
    switch (this.info.kind) {
      case IconKind.Operator: {
        imgData = operatorsIndexNonReactive.operatorImgData.get(opName);
        break;
      }
      case IconKind.OperatorAbility: {
        imgData = operatorsIndexNonReactive.abilityImgData.get(opName);

        ctx.fillStyle = `rgb(${loadout.color[0]}, ${loadout.color[1]}, ${loadout.color[2]})`;
        ctx.fillRect(aabb.minPt.x, aabb.minPt.y, aabb.width(), aabb.height());
        break;
      }
    }

    if (imgData) {
      ctx.drawImage(imgData, aabb.minPt.x, aabb.minPt.y, aabb.width(), aabb.height());
    }
  }
  mapPoints(map: (pt: Vec2) => Vec2): void {
    this.pos = map(this.pos)
  }
}

class StratEditingPhaseFloor {
  drawPaths: Map<Uuid, DrawPath> = new Map();
  arrows: Map<Uuid, Arrow> = new Map();
  icons: Map<Uuid, IconPlacement> = new Map();

  pushDrawElement(drawElement: DrawElement): Uuid {
    const id = new Uuid();
    const elem = drawElement.asEnum();
    switch (elem.kind) {
      case DrawElementKind.DrawPath: {
        this.drawPaths.set(id, elem.data);
        break;
      }
      case DrawElementKind.Arrow: {
        this.arrows.set(id, elem.data);
        break;
      }
      case DrawElementKind.Icon: {
        this.icons.set(id, elem.data);
        break;
      }
    }
    return id;
  }

  allDrawElements(): Uuid[] {
    return Array.from(this.drawPaths.keys())
      .concat(Array.from(this.arrows.keys()))
      .concat(Array.from(this.icons.keys()));
  }

  getDrawElement(id: Uuid): DrawElement | undefined {
    const path = this.drawPaths.get(id);
    if (path) {
      return path;
    }

    const arrow = this.arrows.get(id);
    if (arrow) {
      return arrow;
    }

    const icon = this.icons.get(id);
    if (icon) {
      return icon;
    }
  }

  setDrawElement(id: Uuid, elem: DrawElement) {
    const drawElement = elem.asEnum();
    switch (drawElement.kind) {
      case DrawElementKind.DrawPath: {
        this.drawPaths.set(id, drawElement.data);
        break;
      }
      case DrawElementKind.Arrow: {
        this.arrows.set(id, drawElement.data);
        break;
      }
      case DrawElementKind.Icon: {
        this.icons.set(id, drawElement.data);
        break;
      }
    }
  }

  deleteDrawElement(id: Uuid): boolean {
    // We take advantage of short-circuiting OR to return once we've found the element
    return this.drawPaths.delete(id)
      || this.arrows.delete(id)
      || this.icons.delete(id);
  }
}

enum DrawActionKind {
  PlaceDrawElement,
  MoveDrawElement,
  DeleteDrawElement,
}

type DrawAction =
  { kind: DrawActionKind.PlaceDrawElement, data: DrawElement, floor: number, id: Uuid } |
  { kind: DrawActionKind.MoveDrawElement, delta: Vec2, floor: number, id: Uuid } |
  { kind: DrawActionKind.DeleteDrawElement, data: DrawElement, floor: number, id: Uuid };

class StratEditingPhase {
  phaseName: string = "---";
  floors: StratEditingPhaseFloor[] = [];

  private previousDrawActions: DrawAction[] = [];
  redoStack: DrawAction[] = [];

  getPreviousDrawActionsRef(): DrawAction[] {
    return this.previousDrawActions;
  }

  pushPreviousDrawAction(action: DrawAction) {
    this.previousDrawActions.push(action);
    this.redoStack = [];
  }
}

class FreeDrawToolState {
  currentPath: Uuid | undefined = undefined;
}

class ArrowToolState {
  arrowHasBeenStarted: boolean = false;
  arrowStartPoint: Vec2 = new Vec2(0, 0);
}

class PlaceIconToolState {
  selectedIcon: IconInfo = new IconInfo();
}

class SelectAndEditToolState {
  selected: AnyDrawElementId | undefined = undefined;
  isDragging: boolean = false;
  currDragTotalDelta: Vec2 = new Vec2(0, 0);
  isDeleteQueued: boolean = false;
}

class ToolStates {
  freeDraw: FreeDrawToolState = new FreeDrawToolState();
  arrow: ArrowToolState = new ArrowToolState();
  placeIcon: PlaceIconToolState = new PlaceIconToolState();
  selectAndEdit: SelectAndEditToolState = new SelectAndEditToolState();
}

class StratEditingLoadout {
  static readonly defaultPalette: [number, number, number][] = [
    [175, 43, 191],
    [161, 78, 191],
    [108, 145, 191],
    [95, 176, 183],
    [91, 200, 175],
  ];

  operator: string = "ace";
  color: [number, number, number] = [1, 2, 3];
}

class StratEditingState {
  teamLoadouts: StratEditingLoadout[] = newArrayOfSize(5, (idx) => {
    let l = new StratEditingLoadout();
    l.color = StratEditingLoadout.defaultPalette[idx];
    return l;
  });

  prevSelectedDrawTool: DrawTool = DrawTool.FreeDraw;
  selectedDrawTool: DrawTool = DrawTool.FreeDraw;
  toolStates: ToolStates = new ToolStates();

  stratId: string = "";
  stratName: string = "";
  map: string = "";
  mapFloors: string[] = [];
  mapImgWidth: number = 1600;
  mapImgHeight: number = 900;
  selectedFloor: number = 0;

  phases: StratEditingPhase[] = [];
  selectedPhase: number = 0;

  reset() {
    Object.assign(this, new StratEditingState());
  }

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

class StratEditingDisplayLoadout {
  operator: string = "ace";
}

/** This contains a subset of `StratEditingState` to be used as reactive state for the UI.
 * In order to modify this state, always edit `StratEditingState` and call `updateStratEditingStateDisplay()`
 */
class StratEditingStateDisplay {
  teamLoadouts: StratEditingDisplayLoadout[] = newArrayOfSize(5, () => new StratEditingDisplayLoadout());
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

const inputCanvasState = InputCanvasState.Instance;

const stratEditorFreeDrawCanvasId = "strat-editor-free-draw-canvas";

const mapList = ["chalet", "coastline"];

class OperatorsIndexImgPathOverride {
  operator: string = "";
  img_path: string = "";
}

class OperatorsIndex {
  static readonly abilityImgDataStyle: React.CSSProperties = { maxHeight: 48, maxWidth: 56 };

  // Part of the JSON...
  attackers: string[] = [];
  defenders: string[] = [];
  img_path_override: OperatorsIndexImgPathOverride[] = [];

  // Normal fields...
  operatorImgData: Map<string, CanvasImageSource> = new Map();
  abilityImgData: Map<string, CanvasImageSource> = new Map();

  allOperators(): string[] {
    return this.attackers.concat(this.defenders);
  }

  getOperatorIconPath(operator: string): string {
    for (const override of this.img_path_override) {
      if (override.operator == operator) {
        return override.img_path;
      }
    }

    return `./operators/svg/${operator}.svg`;
  }

  getOperatorAbilityIconPath(operator: string): string {
    return `./abilities/ability_${operator}.webp`;
  }
}
let operatorsIndexNonReactive = new OperatorsIndex();

let websocket: WebSocket | null = null;

function arrayChunk<T>(array: T[], chunkSize: number): T[][] {
  if (chunkSize == 0) {
    return [];
  }
  let chunkedArray: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunkedArray.push(array.slice(i, i + chunkSize));
  }

  return chunkedArray;
}

function newArrayOfSize<T>(size: number, create: (idx: number) => T): T[] {
  const arr: T[] = [];
  for (let idx = 0; idx < size; idx += 1) {
    arr.push(create(idx));
  }
  return arr;
}

function App() {
  const [stratEditingStateDisplay, setStratEditingStateDisplay] = useState<StratEditingStateDisplay>(new StratEditingStateDisplay());

  const [currPage, setCurrPage] = useState<Page>(Page.ConnectToServerPage);

  const [stratList, setStratList] = useState<Array<StratMetadata>>([]);

  const [operatorsIndexReactive, setOperatorsIndexReactive] = useState<OperatorsIndex>(new OperatorsIndex());

  enum ConnectionState {
    WaitingForIP = "Waiting for IP Address (or Connection Failed)",
    Connecting = "Connecting to Server...",
    Connected = "Connected"
  }

  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.WaitingForIP);

  const [selectOperatorForTeammateActiveIdx, setSelectOperatorForTeammateActiveIdx] = useState<number | undefined>(undefined);

  // Load operators
  useEffect(() => {
    async function loadOperatorsIndex() {
      const ops: OperatorsIndex = await fetch("./operators/operators_index.json").then((response) => {
        return response.json();
      }).then((asJson) => {
        return Object.assign(new OperatorsIndex(), asJson);
      });

      async function imgElemFromPath(path: string): Promise<HTMLImageElement> {
        const imgElem = document.createElement("img") as HTMLImageElement;
        imgElem.setAttribute("src", path);
        return imgElem;
      }

      for (const opName of ops.allOperators()) {
        // Load operator icons
        ops.operatorImgData.set(opName, await imgElemFromPath(ops.getOperatorIconPath(opName)));
        const abilityImg = await imgElemFromPath(ops.getOperatorAbilityIconPath(opName));
        ops.abilityImgData.set(opName, abilityImg);
      }

      setOperatorsIndexReactive(ops);
      operatorsIndexNonReactive = ops;
    }
    loadOperatorsIndex();
  }, []);

  function println(msg: string) {
    invoke("console_println", { msg })
  }

  function getFloorImgPath(map: string, floor: string): string {
    return `/maps/${map}/${floor}.jpg`
  }

  function updateStratEditingStateDisplay() {
    const newDisplayState: StratEditingStateDisplay = {
      teamLoadouts: stratEditingState.teamLoadouts.map((l) => { return { operator: l.operator } }),
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

  function operatorTileListComponent(onClick: (opName: string) => void, includeNames: boolean, attackers: boolean, defenders: boolean, rowWidthOverride?: number, imgSizeOverride?: number) {
    var ops: string[] = []

    if (attackers && defenders) {
      ops = operatorsIndexReactive.allOperators();
    } else if (attackers) {
      ops = operatorsIndexReactive.attackers;
    } else if (defenders) {
      ops = operatorsIndexReactive.defenders;
    }

    // Note: this is a test for the "truthyness" of widthOverride, which means that `widthOverride == 0` will *also* go to `10`
    const rowWidth = rowWidthOverride ? rowWidthOverride : 10;
    var rows: string[][] = arrayChunk(ops, rowWidth);

    var imgSize = (imgSizeOverride === undefined) ? 32 : imgSizeOverride;

    return (<>
      <div className="col">
        {rows.map((row) =>
          <div className="row">
            {row.map((opName) =>
              <button className="col" style={{ margin: 1, padding: 0, width: "fit-content", height: "fit-content" }} onClick={(_) => onClick(opName)}>
                <img src={operatorsIndexReactive.getOperatorIconPath(opName)} width="256" height="256" style={{ margin: 0, width: imgSize, height: imgSize }} alt="" />
                {includeNames ? <p>{opName}</p> : undefined}
              </button>
            )}
          </div>
        )}
      </div>
    </>)
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
    const placementPreviewCanvasId = "arrow-placement-preview-canvas";

    /**
     * 
     * @param carets A positive number indicates pointing upwards, a negative number indicates pointing downwards
     */
    function drawCaretToCanvas(canvasId: string, carets: number, pos: Vec2) {
      carets = Math.trunc(carets);
      if (carets == 0) {
        return;
      }

      const canvas = document.getElementById(canvasId);
      if (canvas == null) {
        return;
      }

      const ctx = (canvas as HTMLCanvasElement).getContext("2d");
      if (ctx == null) {
        return;
      }

      const length = 5;

      let offsetRight = new Vec2(1, 0).rotated(-0.4).scaled(length);
      if (carets < 0) {
        offsetRight = new Vec2(offsetRight.x, -offsetRight.y);
      }
      let offsetLeft = new Vec2(-offsetRight.x, offsetRight.y);

      let ptLeft = offsetRight.add(pos);
      let ptRight = offsetLeft.add(pos);

      ctx.beginPath();
      ctx.strokeStyle = "blue";
      ctx.lineWidth = 1.5;

      ctx.moveTo(ptLeft.x, ptLeft.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.lineTo(ptRight.x, ptRight.y);

      ctx.stroke();
      ctx.closePath();
    }

    function drawElementToCanvas(canvasId: string, elem: DrawElement) {
      const canvas = document.getElementById(canvasId);
      if (canvas == null) {
        return;
      }

      const ctx = (canvas as HTMLCanvasElement).getContext("2d");
      if (ctx == null) {
        return;
      }
      elem.drawToCtx(ctx);
      const aabb = elem.boundingBox();
      const caretPt = new Vec2(aabb.minPt.x, (aabb.minPt.y + aabb.maxPt.y) / 2);
      drawCaretToCanvas(canvasId, 0, caretPt);
    }

    function redrawFreeDrawCanvas(canvasId: string) {
      const canvas = document.getElementById(canvasId)! as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const phaseFloor = stratEditingState.currentPhaseFloor();
      if (phaseFloor) {
        phaseFloor.drawPaths.forEach((path) => {
          drawElementToCanvas(canvasId, path);
        });
        phaseFloor.arrows.forEach((arrow) => {
          drawElementToCanvas(canvasId, arrow);
        });
        phaseFloor.icons.forEach((icon) => {
          drawElementToCanvas(canvasId, icon);
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
        const placementPreviewCanvas = document.getElementById(placementPreviewCanvasId)! as HTMLCanvasElement;
        const placementPreviewCtx = placementPreviewCanvas.getContext("2d")!;
        placementPreviewCtx.clearRect(0, 0, placementPreviewCanvas.width, placementPreviewCanvas.height);

        if (!phaseFloor) {
          return;
        }

        if (stratEditingState.prevSelectedDrawTool != stratEditingState.selectedDrawTool) {
          // A common pattern is:
          // 1. set new draw tool
          // 2. set some part of state for new draw tool
          // Thus, we should only clear the state of the previous draw tool
          switch (stratEditingState.prevSelectedDrawTool) {
            case DrawTool.FreeDraw: {
              stratEditingState.toolStates.freeDraw = new FreeDrawToolState();
              break;
            }
            case DrawTool.Arrow: {
              stratEditingState.toolStates.arrow = new ArrowToolState();
              break;
            }
            case DrawTool.PlaceIcon: {
              stratEditingState.toolStates.placeIcon = new PlaceIconToolState();
              break;
            }
            case DrawTool.SelectAndEdit: {
              stratEditingState.toolStates.selectAndEdit = new SelectAndEditToolState();
              break;
            }
          }
        }

        switch (stratEditingState.selectedDrawTool) {
          case DrawTool.FreeDraw: {
            const toolState = stratEditingState.toolStates.freeDraw;

            if (inputCanvasState.mouseClicked) {
              if (toolState.currentPath) {
                // Continue existing path
                phaseFloor.drawPaths.get(toolState.currentPath)?.points.push(inputCanvasState.mousePos.clone());
              } else {
                // Create new path
                var path = new DrawPath();
                path.points.push(inputCanvasState.mousePos.clone());
                const id = phaseFloor.pushDrawElement(path);
                stratEditingState.phases[stratEditingState.selectedPhase].pushPreviousDrawAction({
                  kind: DrawActionKind.PlaceDrawElement,
                  data: path,
                  floor: stratEditingState.selectedFloor,
                  id,
                });
                toolState.currentPath = id;
              }

              // Draw path to canvas immediately, avoiding a rerender
              if (inputCanvasState.prevMouseClicked) {
                var path = new DrawPath();
                path.points = [inputCanvasState.prevMousePos.clone(), inputCanvasState.mousePos.clone()];
                drawElementToCanvas(stratEditorFreeDrawCanvasId, path);
              }
            } else {
              toolState.currentPath = undefined;
            }
            break;
          }
          case DrawTool.Arrow: {
            const toolState = stratEditingState.toolStates.arrow;

            if (inputCanvasState.mouseClicked && !inputCanvasState.prevMouseClicked) {
              if (toolState.arrowHasBeenStarted) {
                const arrow = new Arrow(toolState.arrowStartPoint.clone(), inputCanvasState.mousePos.clone());
                drawElementToCanvas(stratEditorFreeDrawCanvasId, arrow);
                const id = phaseFloor.pushDrawElement(arrow);
                stratEditingState.phases[stratEditingState.selectedPhase].pushPreviousDrawAction({
                  kind: DrawActionKind.PlaceDrawElement,
                  data: arrow,
                  floor: stratEditingState.selectedFloor,
                  id,
                });
                toolState.arrowHasBeenStarted = false;
              } else {
                toolState.arrowStartPoint = inputCanvasState.mousePos.clone();
                toolState.arrowHasBeenStarted = true;
              }
            }

            if (toolState.arrowHasBeenStarted && !inputCanvasState.mouseClicked) {
              const arrow = new Arrow(toolState.arrowStartPoint.clone(), inputCanvasState.mousePos.clone());
              drawElementToCanvas(placementPreviewCanvasId, arrow);
            }
            break;
          }
          case DrawTool.PlaceIcon: {
            const toolState = stratEditingState.toolStates.placeIcon;

            let iconSize;
            switch (toolState.selectedIcon.kind) {
              case IconKind.Operator: {
                iconSize = 50;
                break;
              }
              case IconKind.OperatorAbility: {
                iconSize = 30;
                break;
              }
            }

            const icon = new IconPlacement(inputCanvasState.mousePos.clone(), iconSize, toolState.selectedIcon);

            if (inputCanvasState.mouseClicked && !inputCanvasState.prevMouseClicked) {
              drawElementToCanvas(stratEditorFreeDrawCanvasId, icon);
              const id = phaseFloor.pushDrawElement(icon);
              stratEditingState.phases[stratEditingState.selectedPhase].pushPreviousDrawAction({
                kind: DrawActionKind.PlaceDrawElement,
                data: icon,
                floor: stratEditingState.selectedFloor,
                id,
              });
            } else {
              drawElementToCanvas(placementPreviewCanvasId, icon);
            }
            break;
          }
          case DrawTool.SelectAndEdit: {
            const toolState = stratEditingState.toolStates.selectAndEdit;
            const phase = stratEditingState.phases[stratEditingState.selectedPhase];

            const prevSelected = toolState.selected?.clone();

            // Clear invalid selected item
            if (toolState.selected) {
              switch (toolState.selected.kind) {
                case DrawElementKind.DrawPath: {
                  const path = phase.floors[toolState.selected.floor].drawPaths.get(toolState.selected.id);
                  if (!path) {
                    toolState.selected = undefined;
                  }
                  break;
                }
                case DrawElementKind.Arrow: {
                  const arrow = phase.floors[toolState.selected.floor].arrows.get(toolState.selected.id);
                  if (!arrow) {
                    toolState.selected = undefined;
                  }
                  break;
                }
                case DrawElementKind.Icon: {
                  const icon = phase.floors[toolState.selected.floor].icons.get(toolState.selected.id);
                  if (!icon) {
                    toolState.selected = undefined;
                  }
                  break;
                }
              }
            }

            // Update selection
            if (inputCanvasState.mouseClicked && !inputCanvasState.prevMouseClicked) {
              function pickFloor(floor: number): AnyDrawElementId | undefined {
                for (const id of phase.floors[floor].allDrawElements().slice().reverse()) {
                  const item = phase.floors[floor].getDrawElement(id);
                  if (item?.isHovered(inputCanvasState.mousePos)) {
                    return new AnyDrawElementId(item.asEnum().kind, floor, id);
                  }
                }
                return undefined;
              }

              // Prioritize picking current floor, then prioritize higher floors
              const floorPriorityOrdering = [stratEditingState.selectedFloor];
              for (let floorIdx = stratEditingState.mapFloors.length - 1; floorIdx >= 0; floorIdx -= 1) {
                if (floorIdx != stratEditingState.selectedFloor) {
                  floorPriorityOrdering.push(floorIdx);
                }
              }

              let itemPicked: AnyDrawElementId | undefined = undefined;
              for (let floor of floorPriorityOrdering) {
                const picked = pickFloor(floor);
                if (picked) {
                  itemPicked = picked;
                  break;
                }
              }

              toolState.selected = itemPicked;
            }

            const selectionChanged = (() => {
              if ((prevSelected === undefined) != (toolState.selected === undefined)) {
                // Only 1 is defined
                return true;
              } else if ((prevSelected !== undefined) && (toolState.selected !== undefined)) {
                // Both are defined
                return !prevSelected.equals(toolState.selected);
              } else {
                // Both are undefined
                return false;
              }
            })();

            if (toolState.selected && toolState.selected.get(phase)) {
              // Draw border around selection
              const boundingBox: Aabb = toolState.selected.get(phase)!.boundingBox();

              placementPreviewCtx.beginPath();

              placementPreviewCtx.strokeStyle = "black";
              placementPreviewCtx.lineWidth = 2;
              placementPreviewCtx.setLineDash([5, 10]);

              placementPreviewCtx.moveTo(boundingBox.minPt.x, boundingBox.minPt.y);
              placementPreviewCtx.lineTo(boundingBox.minPt.x, boundingBox.maxPt.y);
              placementPreviewCtx.lineTo(boundingBox.maxPt.x, boundingBox.maxPt.y);
              placementPreviewCtx.lineTo(boundingBox.maxPt.x, boundingBox.minPt.y);
              placementPreviewCtx.lineTo(boundingBox.minPt.x, boundingBox.minPt.y);

              placementPreviewCtx.stroke();
              placementPreviewCtx.closePath();
              placementPreviewCtx.setLineDash([]);

              // Enter selection dragging mode
              if (!selectionChanged && inputCanvasState.mouseClicked && !inputCanvasState.prevMouseClicked) {
                toolState.isDragging = true;
              } else if (!inputCanvasState.mouseClicked) {
                if (toolState.isDragging && !toolState.currDragTotalDelta.approxEq(new Vec2(0, 0))) {
                  phase.pushPreviousDrawAction({
                    kind: DrawActionKind.MoveDrawElement,
                    delta: toolState.currDragTotalDelta.clone(),
                    floor: toolState.selected.floor,
                    id: toolState.selected.id,
                  });
                }

                toolState.currDragTotalDelta = new Vec2(0, 0);
                toolState.isDragging = false;
              }

              // Drag the selection
              if (toolState.isDragging) {
                const posDelta = inputCanvasState.mousePos.sub(inputCanvasState.prevMousePos);
                toolState.selected.get(phase)!.mapPoints((pt) => pt.add(posDelta));
                toolState.currDragTotalDelta = toolState.currDragTotalDelta.add(posDelta);

                // Somehow this isn't *that* bad for performance??
                redrawFreeDrawCanvas(stratEditorFreeDrawCanvasId);
              }

              // Delete the selection
              if (toolState.isDeleteQueued) {
                phase.pushPreviousDrawAction({
                  kind: DrawActionKind.DeleteDrawElement,
                  data: toolState.selected.get(phase)!,
                  floor: toolState.selected.floor,
                  id: toolState.selected.id,
                });
                phase.floors[toolState.selected.floor].deleteDrawElement(toolState.selected.id);
                toolState.isDeleteQueued = false;
                toolState.selected = undefined;
                redrawFreeDrawCanvas(stratEditorFreeDrawCanvasId);
              }
            }

            break;
          }
        }

        inputCanvasState.prevMouseClicked = inputCanvasState.mouseClicked;
        inputCanvasState.prevMousePos = inputCanvasState.mousePos;

        stratEditingState.prevSelectedDrawTool = stratEditingState.selectedDrawTool;

        requestAnimationFrame(onUpdate);
      }
      requestAnimationFrame(onUpdate);

      function triggerUndo() {
        const previousDrawActionsList = stratEditingState.phases[stratEditingState.selectedPhase]?.getPreviousDrawActionsRef();
        if (!previousDrawActionsList) {
          return;
        }

        if (previousDrawActionsList.length == 0) {
          return;
        }

        const previousDrawAction = previousDrawActionsList.pop()!;

        const phase = stratEditingState.phases[stratEditingState.selectedPhase];
        phase.redoStack.push(previousDrawAction);

        switch (previousDrawAction.kind) {
          case DrawActionKind.PlaceDrawElement: {
            const phaseFloor = phase?.floors[previousDrawAction.floor];
            phaseFloor.deleteDrawElement(previousDrawAction.id);
            if (previousDrawAction.data.asEnum().kind = DrawElementKind.DrawPath) {
              stratEditingState.toolStates.freeDraw.currentPath = undefined;
            }
            break;
          }
          case DrawActionKind.DeleteDrawElement: {
            const phaseFloor = phase?.floors[previousDrawAction.floor];
            phaseFloor.setDrawElement(previousDrawAction.id, previousDrawAction.data);
            break;
          }
          case DrawActionKind.MoveDrawElement: {
            const phaseFloor = phase?.floors[previousDrawAction.floor];
            const elem = phaseFloor.getDrawElement(previousDrawAction.id);
            elem?.mapPoints((pt) => pt.sub(previousDrawAction.delta));
            break;
          }
        }
        redrawFreeDrawCanvas(stratEditorFreeDrawCanvasId);
      }

      function triggerRedo() {
        const phase = stratEditingState.phases[stratEditingState.selectedPhase];
        if (!phase) {
          return;
        }

        const redoAction = phase.redoStack.pop();
        if (!redoAction) {
          return;
        }
        phase.getPreviousDrawActionsRef().push(redoAction);

        switch (redoAction.kind) {
          case DrawActionKind.PlaceDrawElement: {
            const phaseFloor = phase.floors[redoAction.floor];
            phaseFloor.setDrawElement(redoAction.id, redoAction.data);
            drawElementToCanvas(stratEditorFreeDrawCanvasId, redoAction.data);
            break;
          }
          case DrawActionKind.DeleteDrawElement: {
            const phaseFloor = phase.floors[redoAction.floor];
            phaseFloor.deleteDrawElement(redoAction.id);
            redrawFreeDrawCanvas(stratEditorFreeDrawCanvasId);
            break;
          }
          case DrawActionKind.MoveDrawElement: {
            const phaseFloor = phase.floors[redoAction.floor];
            const elem = phaseFloor.getDrawElement(redoAction.id);
            elem?.mapPoints((pt) => pt.add(redoAction.delta));
            redrawFreeDrawCanvas(stratEditorFreeDrawCanvasId);
            break;
          }
        }
      }

      document.onkeydown = (e) => {
        e.code;
        const keyLower = e.key.toLowerCase();
        if (e.ctrlKey && e.shiftKey && keyLower == "z") {
          triggerRedo();
        } else if (e.ctrlKey && keyLower == "z") {
          triggerUndo();
        } else if (keyLower == "delete") {
          if (stratEditingState.selectedDrawTool == DrawTool.SelectAndEdit) {
            stratEditingState.toolStates.selectAndEdit.isDeleteQueued = true;
          }
        }
      };

      return (<>
        <canvas id={inputGatheringCanvasId}
          style={{ gridColumn: 1, gridRow: 1, zIndex: 100 }}
          width={stratEditingStateDisplay.mapImgWidth}
          height={stratEditingStateDisplay.mapImgHeight}
          onMouseEnter={(_e) => inputCanvasState.mouseClicked = false}
          onMouseLeave={(_e) => inputCanvasState.mouseClicked = false}
          onMouseDown={(_e) => inputCanvasState.mouseClicked = true}
          onMouseUp={(_e) => inputCanvasState.mouseClicked = false}
          onMouseMove={(e) => {
            inputCanvasState.mousePos = mousePosForCanvas(inputGatheringCanvasId, e.clientX, e.clientY);
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
        {/* Menuing buttons */}
        <button onClick={(_) => {
          saveProgress().then((_) => {
            stratEditingState.reset();
            updateStratEditingStateDisplay();
            setCurrPage(Page.StratListPage);
          });
        }}>Back to Strat list</button>

        <button onClick={(_) => {
          saveProgress()
        }}>Save Progress</button>

        {/* Edit current phase name & select phase */}
        <div className="row">
          <p>Current Phase: </p>
          <input
            value={stratEditingStateDisplay.phases[stratEditingState.selectedPhase]?.phaseName}
            onChange={(e) => {
              stratEditingState.phases[stratEditingState.selectedPhase].phaseName = e.target.value;
              updateStratEditingStateDisplay();
            }} />
        </div>
        <div className="row">
          {stratEditingStateDisplay.phases.map((phase, i) =>
            <button key={i} onClick={(e) => {
              e.preventDefault();
              stratEditingState.selectedPhase = i;
              stratEditingState.toolStates = new ToolStates();
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

        {/* List of floors */}
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

        {/* Team operator selector */}
        <p>Team</p>
        <div className="row">
          {stratEditingStateDisplay.teamLoadouts.map((loadout, idx) =>
            <div key={idx} className="col" style={{ border: "2px solid #0f0f0f" }}>
              <button style={{ padding: 0 }} onClick={(_e) => {
                stratEditingState.selectedDrawTool = DrawTool.PlaceIcon;
                stratEditingState.toolStates.placeIcon.selectedIcon = { kind: IconKind.Operator, teammateIndex: idx };
                updateStratEditingStateDisplay();
              }}>
                <img src={operatorsIndexReactive.getOperatorIconPath(loadout.operator)} style={{ width: 64, height: 64 }} />
              </button>
              <button onClick={(_e) => {
                if (selectOperatorForTeammateActiveIdx == idx) {
                  setSelectOperatorForTeammateActiveIdx(undefined);
                } else {
                  setSelectOperatorForTeammateActiveIdx(idx);
                }
              }}>Select Operator</button>
              {selectOperatorForTeammateActiveIdx == idx && (
                <div style={{ position: "relative", zIndex: 1000, padding: 0 }}>
                  <div style={{ position: "absolute", zIndex: 1001, top: "32px", left: "-50%", backgroundColor: "#bababa", border: "2px solid #0f0f0f", borderRadius: "8px" }}>
                    {operatorTileListComponent((opName) => {
                      stratEditingState.teamLoadouts[idx].operator = opName;
                      setSelectOperatorForTeammateActiveIdx(undefined);

                      updateStratEditingStateDisplay();
                      redrawFreeDrawCanvas(stratEditorFreeDrawCanvasId);
                    }, false, true, false, 10)}
                  </div>
                </div>
              )}
              <button style={{ paddingTop: 4, paddingBottom: 4, paddingLeft: 0, paddingRight: 0, height: 56 }} onClick={(_e) => {
                stratEditingState.selectedDrawTool = DrawTool.PlaceIcon;
                stratEditingState.toolStates.placeIcon.selectedIcon = { kind: IconKind.OperatorAbility, teammateIndex: idx };
                updateStratEditingStateDisplay();
              }}>
                <img
                  src={operatorsIndexReactive.getOperatorAbilityIconPath(loadout.operator)}
                  style={OperatorsIndex.abilityImgDataStyle}
                />
              </button>
            </div>
          )}
        </div>

        {/* Toolbar and draw area */}
        <div className="row" style={{ justifyItems: "left" }}>
          {/* Toolbar */}
          <div className="col" id="tool-selector-bar" style={{ margin: 8 }}>
            <p>{DrawTool[stratEditingState.selectedDrawTool]}</p>
            <button onClick={(_) => { stratEditingState.selectedDrawTool = DrawTool.SelectAndEdit; updateStratEditingStateDisplay(); }}>Select and edit</button>
            <button onClick={(_) => { stratEditingState.selectedDrawTool = DrawTool.FreeDraw; updateStratEditingStateDisplay(); }}>Free draw</button>
            <button onClick={(_) => { stratEditingState.selectedDrawTool = DrawTool.Arrow; updateStratEditingStateDisplay(); }}>Arrow</button>
          </div>

          {/* Draw Area */}
          <div id="draw-area" style={{ margin: 8, display: "grid", gridTemplateColumns: "1", gridTemplateRows: "1" }}>
            <img src={getFloorImgPath(stratEditingStateDisplay.map, stratEditingStateDisplay.mapFloors[stratEditingStateDisplay.activeFloor])}
              style={{ gridColumn: 1, gridRow: 1, zIndex: 0 }} />
            {freeDrawCanvas(stratEditorFreeDrawCanvasId)}
            <canvas id={placementPreviewCanvasId}
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

  return (
    <main className="container">
      {currPageSelectorComponent(currPage)}
    </main >
  );
}

export default App;
