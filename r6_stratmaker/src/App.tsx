// Credit to https://github.com/marcopixel/r6operators for operator icons except Solid Snake
// Credit to RoseishDesigns on Etsy (https://www.etsy.com/listing/4387393681/derpy-snake-water-bottle-sticker-shnek) for the Solid Snake icon
// Credit to Ubisoft for map blueprints

import { useEffect, useState } from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";
// import WebSocket from "@tauri-apps/plugin-websocket";
import { WS as WebSocket } from "./websocket.ts";
import "./App.css";
import * as protos from "./generated_protos/primary.ts"
import * as uuid from 'uuid';
import * as js_toml from 'js-toml';

class Uuid {
  readonly data: string;
  constructor(data?: string) {
    if (data) {
      this.data = data;
    } else {
      this.data = uuid.v4();
    }
  }
}

interface DrawElement {
  asEnum(): AnyDrawElementData;

  asDrawPath(): DrawPath | undefined;
  asArrow(): Arrow | undefined;
  asIcon(): IconPlacement | undefined;

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
  LobbyListPage,
  InLobbySelectStratPage,
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

  static fromProto(proto: protos.Point): Vec2 {
    return new Vec2(proto.x, proto.y);
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
  points: Array<Vec2>;
  color: [number, number, number];

  constructor(points: Array<Vec2>, color: [number, number, number]) {
    this.points = points;
    this.color = color;
  }

  asEnum(): AnyDrawElementData {
    return { kind: DrawElementKind.DrawPath, data: this };
  }
  asDrawPath(): DrawPath | undefined {
    return this;
  }
  asArrow(): Arrow | undefined {
    return undefined;
  }
  asIcon(): IconPlacement | undefined {
    return undefined;
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
    ctx.strokeStyle = `rgb(${this.color[0]}, ${this.color[1]}, ${this.color[2]})`;
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
  color: [number, number, number];

  constructor(start: Vec2, end: Vec2, color: [number, number, number]) {
    this.start = start;
    this.end = end;
    this.color = color;
  }

  asEnum(): AnyDrawElementData {
    return { kind: DrawElementKind.Arrow, data: this };
  }
  asDrawPath(): DrawPath | undefined {
    return undefined;
  }
  asArrow(): Arrow | undefined {
    return this;
  }
  asIcon(): IconPlacement | undefined {
    return undefined;
  }
  isHovered(mousePos: Vec2): boolean {
    return mousePos.distanceToLine(this.start, this.end, false, false).distance < 5;
  }
  boundingBox(): Aabb {
    return Aabb.fromPoints([this.start, this.end]);
  }
  drawToCtx(ctx: CanvasRenderingContext2D): void {
    ctx.beginPath();
    ctx.strokeStyle = `rgb(${this.color[0]}, ${this.color[1]}, ${this.color[2]})`;
    ctx.lineWidth = 3;

    ctx.moveTo(this.start.x, this.start.y);
    ctx.lineTo(this.end.x, this.end.y);

    const makeHeadPoint = (side: boolean, isFixedLength: boolean, fixedLength: number): Vec2 => {
      var rot = side ? 0.1 : -0.1;
      var a = this.end.sub(this.start).rotated(rot).scaled(0.9).add(this.start);
      if (isFixedLength) {
        a = a.sub(this.end).normalized().scaled(fixedLength).add(this.end);
      }

      return a;
    };

    const headPt0 = makeHeadPoint(true, true, 10);
    const headPt1 = makeHeadPoint(false, true, 10);

    ctx.moveTo(headPt0.x, headPt0.y);
    ctx.lineTo(this.end.x, this.end.y)
    ctx.lineTo(headPt1.x, headPt1.y);

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
  TeamOperator,
  TeamAbility,
  TeamUtility,
  FreeOperator,
  FreeAbility,
  FreeUtility,
}

type IconInfo =
  { kind: IconKind.TeamOperator, teammateIndex: number }
  | { kind: IconKind.TeamAbility, teammateIndex: number }
  | { kind: IconKind.TeamUtility, teammateIndex: number }
  | { kind: IconKind.FreeOperator, operator: string }
  | { kind: IconKind.FreeAbility, operator: string }
  | { kind: IconKind.FreeUtility, util: string };

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
  asDrawPath(): DrawPath | undefined {
    return undefined;
  }
  asArrow(): Arrow | undefined {
    return undefined;
  }
  asIcon(): IconPlacement | undefined {
    return this;
  }
  isHovered(mousePos: Vec2): boolean {
    return this.boundingBox().containsPoint(mousePos);
  }
  boundingBox(): Aabb {
    var width = 0;
    var height = 0;

    function imgAspectRatio(imgData: CanvasImageSource): number {
      const imgElem: HTMLImageElement = imgData! as HTMLImageElement;
      return imgElem.width / imgElem.height;
    }

    // const loadout = stratEditingState.teamLoadouts[this.info.teammateIndex];
    switch (this.info.kind) {
      case IconKind.TeamOperator: {
        width = this.size;
        height = this.size;
        break;
      }
      case IconKind.TeamAbility: {
        height = this.size;
        const loadout = stratEditingState.teamLoadouts[this.info.teammateIndex];
        width = height * imgAspectRatio(operatorsIndexNonReactive.abilityImgData.get(loadout.operator)!);
        break;
      }
      case IconKind.TeamUtility: {
        height = this.size;
        const loadout = stratEditingState.teamLoadouts[this.info.teammateIndex];
        width = height * imgAspectRatio(operatorsIndexNonReactive.utilityImgData.get(loadout.util)!);
        break;
      }
      case IconKind.FreeOperator: {
        width = this.size;
        height = this.size;
        break;
      }
      case IconKind.FreeAbility: {
        height = this.size;
        width = height * imgAspectRatio(operatorsIndexNonReactive.abilityImgData.get(this.info.operator)!);
        break;
      }
      case IconKind.FreeUtility: {
        height = this.size;
        width = height * imgAspectRatio(operatorsIndexNonReactive.utilityImgData.get(this.info.util)!);
        break;
      }
    }

    return Aabb.fromPoints([this.pos, this.pos.add(new Vec2(width, height))]);
  }
  drawToCtx(ctx: CanvasRenderingContext2D): void {
    var imgData: CanvasImageSource | undefined;

    var aabb = this.boundingBox();

    switch (this.info.kind) {
      case IconKind.TeamOperator: {
        const loadout = stratEditingState.teamLoadouts[this.info.teammateIndex];
        ctx.fillStyle = `rgb(${loadout.color[0]}, ${loadout.color[1]}, ${loadout.color[2]})`;
        imgData = operatorsIndexNonReactive.operatorImgData.get(loadout.operator);
        break;
      }
      case IconKind.TeamAbility: {
        const loadout = stratEditingState.teamLoadouts[this.info.teammateIndex];
        ctx.fillStyle = `rgb(${loadout.color[0]}, ${loadout.color[1]}, ${loadout.color[2]})`;
        imgData = operatorsIndexNonReactive.abilityImgData.get(loadout.operator);
        break;
      }
      case IconKind.TeamUtility: {
        const loadout = stratEditingState.teamLoadouts[this.info.teammateIndex];
        ctx.fillStyle = `rgb(${loadout.color[0]}, ${loadout.color[1]}, ${loadout.color[2]})`;
        imgData = operatorsIndexNonReactive.utilityImgData.get(loadout.util);
        break;
      }
      case IconKind.FreeOperator: {
        ctx.fillStyle = `rgb(128, 128, 128)`;
        imgData = operatorsIndexNonReactive.operatorImgData.get(this.info.operator);
        break;
      }
      case IconKind.FreeAbility: {
        ctx.fillStyle = `rgb(128, 128, 128)`;
        imgData = operatorsIndexNonReactive.abilityImgData.get(this.info.operator);
        break;
      }
      case IconKind.FreeUtility: {
        ctx.fillStyle = `rgb(128, 128, 128)`;
        imgData = operatorsIndexNonReactive.utilityImgData.get(this.info.util);
        break;
      }
    }
    ctx.fillRect(aabb.minPt.x, aabb.minPt.y, aabb.width(), aabb.height());

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

  pushDrawElement(drawElement: DrawElement): Uuid {
    const id = new Uuid();
    this.setDrawElement(id, drawElement);
    return id;
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
  selectedIcon: IconInfo = { kind: IconKind.FreeOperator, operator: "" };
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
    [150, 245, 80],
    [229, 99, 153],
    [127, 150, 255],
    [166, 207, 213],
    [255, 188, 66],
  ];

  operator: string = "ace";
  color: [number, number, number] = [1, 2, 3];
  util: string = "";
}

enum StratEditingMode {
  Singleplayer,
  Lobby,
}

class StratEditingState {
  static readonly freeDrawPalette: [number, number, number][] = StratEditingLoadout.defaultPalette.concat([
    [200, 10, 10],
    [10, 200, 10],
    [10, 10, 200],
    [200, 200, 10],
  ]);

  mode: StratEditingMode = StratEditingMode.Singleplayer;
  lobbyMembers: string[] = [];

  selectedDrawColor: [number, number, number] = StratEditingState.freeDrawPalette[0];

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

  private phases: StratEditingPhase[] = [];
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

  pushDrawElement(phase: number, floor: number, drawElement: DrawElement): Uuid {
    const id = new Uuid();
    this.setDrawElement(phase, floor, id, drawElement);
    return id;
  }

  /** Use with care! Does not notify server of changes */
  getDrawElementRef(phase: number, floor: number, id: Uuid): DrawElement | undefined {
    const phaseFloor = this.phases[phase]?.floors[floor];
    if (!phaseFloor) {
      return undefined;
    }

    return phaseFloor.getDrawElement(id);
  }

  setDrawElement(phase: number, floor: number, id: Uuid, drawElement: DrawElement) {
    const phaseFloor = this.phases[phase]?.floors[floor];
    if (!phaseFloor) {
      return;
    }

    if (this.mode == StratEditingMode.Lobby) {
      //
      console.log("TODO: Notify server of draw element changes");
    }

    phaseFloor.setDrawElement(id, drawElement);
  }

  setPhaseName(phase: number, newName: string) {
    const phaseRef = this.phases[phase];
    if (!phaseRef) {
      return;
    }

    if (this.mode == StratEditingMode.Lobby) {
      console.log("TODO: Notify server of phase name changes");
    }

    phaseRef.phaseName = newName;
  }

  deleteDrawElement(phase: number, floor: number, id: Uuid) {
    const phaseFloor = this.phases[phase]?.floors[floor];
    if (!phaseFloor) {
      return;
    }

    if (phaseFloor.deleteDrawElement(id)) {
      if (this.mode == StratEditingMode.Lobby) {
        //
        console.log("TODO: Notify server of draw element changes");
      }
      //
    }
  }

  pushPreviousDrawAction(phase: number, action: DrawAction) {
    const phaseRef = this.phases[phase];
    if (!phaseRef) {
      return;
    }

    phaseRef.pushPreviousDrawAction(action);
  }

  getPreviousDrawActionsRef(phase: number): DrawAction[] {
    const phaseRef = this.phases[phase];
    if (!phaseRef) {
      return [];
    }

    return phaseRef.getPreviousDrawActionsRef();
  }

  /** Use with care! Does not activate any side effects, just gives a raw reference to the phases*/
  getPhasesRef(): StratEditingPhase[] {
    return this.phases;
  }

  /** Use with care! */
  setPhasesRaw(phases: StratEditingPhase[]) {
    this.phases = phases;
  }

  currentPhaseFloorIsValid(): boolean {
    return this.selectedPhase < this.phases.length && this.selectedFloor < this.phases[this.selectedPhase].floors.length;
  }
}

const stratEditingState = new StratEditingState();
let redrawFreeDrawCanvasQueued: boolean = false;

const inputCanvasState = InputCanvasState.Instance;

const stratEditorFreeDrawCanvasId = "strat-editor-free-draw-canvas";

const mapList = ["chalet", "coastline"];

class OperatorInfo {
  op_name: string = "";
  utils: string[] = [];
  img_path_override: string | undefined = undefined;
}

class OperatorsIndex {
  static readonly abilityImgDataStyle: React.CSSProperties = { maxHeight: 48, maxWidth: 56 };

  // Part of the JSON...
  attackers: string[] = [];
  defenders: string[] = [];
  operators: Map<string, OperatorInfo> = new Map();

  // Normal fields...
  operatorImgData: Map<string, CanvasImageSource> = new Map();
  abilityImgData: Map<string, CanvasImageSource> = new Map();
  utilityImgData: Map<string, CanvasImageSource> = new Map();

  getOperatorIconPath(operator: string): string {
    const op = this.operators.get(operator);
    if (op?.img_path_override) {
      return op?.img_path_override;
    }

    return `./operators/svg/${operator}.svg`;
  }

  getOperatorAbilityIconPath(operator: string): string {
    return `./abilities/ability_${operator}.webp`;
  }

  getUtilityIconPath(utility: string): string {
    return `./secondary_utilities/${utility}.webp`;
  }

  static async fromString(file: string): Promise<OperatorsIndex> {
    let ops = new OperatorsIndex();

    const data: Record<string, any> = js_toml.load(file);

    const loadOperator = (op: [string, any], isAttacker: boolean) => {
      if (isAttacker) {
        ops.attackers.push(op[0]);
      } else {
        ops.defenders.push(op[0]);
      }

      let opInfo = new OperatorInfo();
      opInfo.op_name = op[0];
      opInfo.utils = op[1].utils;
      opInfo.img_path_override = op[1].img_path_override;

      ops.operators.set(op[0], opInfo);
    };

    for (const op of Object.entries(data["attackers"])) {
      loadOperator(op, true);
    }
    for (const op of Object.entries(data["defenders"])) {
      loadOperator(op, false);
    }

    async function imgElemFromPath(path: string): Promise<HTMLImageElement> {
      const imgElem = document.createElement("img") as HTMLImageElement;
      imgElem.setAttribute("src", path);
      return imgElem;
    }

    for (const op of ops.operators) {
      const opName = op[0];
      for (const util of op[1].utils) {
        if (!ops.utilityImgData.has(util)) {
          ops.utilityImgData.set(util, await imgElemFromPath(ops.getUtilityIconPath(util)));
        }
      }
      ops.operatorImgData.set(opName, await imgElemFromPath(ops.getOperatorIconPath(opName)));
      const abilityImg = await imgElemFromPath(ops.getOperatorAbilityIconPath(opName));
      ops.abilityImgData.set(opName, abilityImg);
    }

    return ops;
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

function lerp(start: number, end: number, t: number): number {
  return start * (1 - t) + end * t;
}

function mapMap<K1, V1, K2, V2>(map: Map<K1, V1>, cb: (k: K1, v: V1) => [K2, V2]): Map<K2, V2> {
  let outMap = new Map();

  for (const entry of map) {
    const out = cb(entry[0], entry[1]);
    outMap.set(out[0], out[1]);
  }

  return outMap;
}

function mapMapToObject<K1, V1, V2>(map: Map<K1, V1>, cb: (k: K1, v: V1) => [string, V2]): Record<string, V2> {
  let record: Record<string, V2> = {};

  for (const entry of mapMap(map, cb)) {
    record[entry[0]] = entry[1];
  }

  return record;
}

function colorToProto(color: [number, number, number]): protos.Color {
  return { r: color[0], g: color[1], b: color[2] };
}

function colorFromProto(color: protos.Color): [number, number, number] {
  return [color.r, color.g, color.b];
}

function App() {
  const [stratEditingStateDisplay, setStratEditingStateDisplay] = useState<StratEditingState>(new StratEditingState());

  const [currPage, setCurrPage] = useState<Page>(Page.ConnectToServerPage);

  const [stratList, setStratList] = useState<Array<StratMetadata>>([]);

  const [lobbyList, setLobbyList] = useState<Array<string>>([]);

  const [operatorsIndexReactive, setOperatorsIndexReactive] = useState<OperatorsIndex>(new OperatorsIndex());

  enum ConnectionState {
    WaitingForIP = "Waiting for IP Address (or Connection Failed)",
    Connecting = "Connecting to Server...",
    Connected = "Connected"
  }

  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.WaitingForIP);

  const [selectOperatorForTeammateActiveIdx, setSelectOperatorForTeammateActiveIdx] = useState<number | undefined>(undefined);
  const [selectUtilityForTeammateActiveIdx, setSelectUtilityForTeammateActiveIdx] = useState<number | undefined>(undefined);


  // Load operators
  useEffect(() => {
    async function loadOperatorsIndex() {
      const ops: OperatorsIndex = await fetch("./operators/operators_index.toml").then((response) => {
        return response.text().then((r) => OperatorsIndex.fromString(r));
      });

      setOperatorsIndexReactive(ops);
      operatorsIndexNonReactive = ops;
    }
    loadOperatorsIndex();
  }, []);

  function println(msg: string) {
    if (isTauri()) {
      invoke("console_println", { msg })
    } else {
      console.log(msg);
    }
  }

  function getFloorImgPath(map: string, floor: string): string {
    return `/maps/${map}/${floor}.jpg`
  }

  function updateStratEditingStateDisplay() {
    // If we don't create a new object, then it won't be detected as a change
    const newDisplayState: StratEditingState = Object.assign(new StratEditingState(), stratEditingState);
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
      sendNetworkMessage(protos.Client2Server.create({ getStratList: {} }));
      setCurrPage(Page.StratListPage);
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
      const state: protos.StratState = msg.getStratInfoResponse.state!;
      stratEditingState.stratName = state.stratName;
      stratEditingState.teamLoadouts = state.teammates.map((teammate) => {
        return { operator: teammate.operator, color: colorFromProto(teammate.color!), util: teammate.util }
      });
      stratEditingState.setPhasesRaw(state.phases.map((protoPhase) => {
        let phase = new StratEditingPhase();
        phase.phaseName = protoPhase.phaseName;
        phase.floors = protoPhase.floors.map((protoFloor) => {
          let floor = new StratEditingPhaseFloor();
          for (const id in protoFloor.drawPaths) {
            let path = protoFloor.drawPaths[id];
            floor.drawPaths.set(new Uuid(id), new DrawPath(path.points.map((pt) => Vec2.fromProto(pt)), colorFromProto(path.color!)));
          }
          for (const id in protoFloor.arrows) {
            let arrow = protoFloor.arrows[id];
            floor.arrows.set(new Uuid(id), new Arrow(Vec2.fromProto(arrow.start!), Vec2.fromProto(arrow.end!), colorFromProto(arrow.color!)));
          }
          for (const id in protoFloor.icons) {
            let icon = protoFloor.icons[id];

            let parsedIconInfo: IconInfo;
            if (icon.teamOperator) {
              parsedIconInfo = { kind: IconKind.TeamOperator, teammateIndex: icon.teamOperator.teammateIdx };
            } else if (icon.teamAbility) {
              parsedIconInfo = { kind: IconKind.TeamAbility, teammateIndex: icon.teamAbility.teammateIdx };
            } else if (icon.teamUtility) {
              parsedIconInfo = { kind: IconKind.TeamUtility, teammateIndex: icon.teamUtility.teammateIdx };
            } else if (icon.freeOperator) {
              parsedIconInfo = { kind: IconKind.FreeOperator, operator: icon.freeOperator.operator };
            } else if (icon.freeAbility) {
              parsedIconInfo = { kind: IconKind.FreeAbility, operator: icon.freeAbility.ability };
            } else if (icon.freeUtility) {
              parsedIconInfo = { kind: IconKind.FreeUtility, util: icon.freeUtility.util };
            } else {
              let e = "UNHANDLED BRANCH: parsedIconInfo";
              println(e);
              throw new Error(e);
            };

            let iconSize;
            switch (parsedIconInfo.kind) {
              case IconKind.TeamOperator: {
                iconSize = 50;
                break;
              }
              case IconKind.TeamAbility: {
                iconSize = 30;
                break;
              }
              case IconKind.TeamUtility: {
                iconSize = 30;
                break;
              }
              case IconKind.FreeOperator: {
                iconSize = 50;
                break;
              }
              case IconKind.FreeAbility: {
                iconSize = 30;
                break;
              }
              case IconKind.FreeUtility: {
                iconSize = 30;
                break;
              }
            }
            floor.icons.set(new Uuid(id), new IconPlacement(Vec2.fromProto(icon.pos!), iconSize, parsedIconInfo));
          }

          return floor;
        });
        return phase;
      }));
      setCurrPage(Page.StratEditorPage);
      updateStratEditingStateDisplay();
      redrawFreeDrawCanvasQueued = true;
    } else if (msg.getLobbyListResponse) {
      setLobbyList(msg.getLobbyListResponse.hosts);
    } else if (msg.joinLobbyResponse) {
      setCurrPage(Page.InLobbySelectStratPage);
    } else if (msg.updateLobbyMembers) {
      stratEditingState.lobbyMembers = msg.updateLobbyMembers.members;
      updateStratEditingStateDisplay();
    } else if (msg.saveStratResponse) {
      // Yay!
    } else if (msg.createLobbyResponse) {
      setCurrPage(Page.InLobbySelectStratPage)
    } else {
      println(`  Unhandled message!!!`);
    }
  }

  function tileListComponent<T>(keys: T[], listInnerComponent: (key: T) => any, onClick: (key: T) => void, rowWidthOverride?: number) {
    // Note: this is a test for the "truthyness" of widthOverride, which means that `widthOverride == 0` will *also* go to `10`
    const rowWidth = rowWidthOverride ? rowWidthOverride : 10;
    var rows: T[][] = arrayChunk(keys, rowWidth);

    return (<>
      <div className="col">
        {rows.map((row) =>
          <div className="row">
            {row.map((key) =>
              <button className="col" style={{ margin: 1, padding: 0, width: "fit-content", height: "fit-content" }} onClick={(_) => onClick(key)}>
                {listInnerComponent(key)}
              </button>
            )}
          </div>
        )}
      </div>
    </>)
    //
  }

  function utilityTileListComponent(onClick: (util: string) => void, utilForOp?: string, rowWidthOverride?: number) {
    const utils = utilForOp ? operatorsIndexNonReactive.operators.get(utilForOp)!.utils : Array.from(operatorsIndexNonReactive.utilityImgData.keys());

    return tileListComponent(utils, (util) => <>
      <img
        src={operatorsIndexReactive.getUtilityIconPath(util)}
        width="256"
        height="256"
        style={{ margin: 0, width: 32, height: 32 }}
        alt=""
      />
    </>, onClick, rowWidthOverride)
  }

  function operatorTileListComponent(onClick: (opName: string) => void, includeNames: boolean, attackers: boolean, defenders: boolean, rowWidthOverride?: number, imgSizeOverride?: number) {
    var ops: string[] = []

    if (attackers && defenders) {
      ops = Array.from(operatorsIndexReactive.operators.keys());
    } else if (attackers) {
      ops = operatorsIndexReactive.attackers;
    } else if (defenders) {
      ops = operatorsIndexReactive.defenders;
    }

    // Note: this is a test for the "truthyness" of widthOverride, which means that `widthOverride == 0` will *also* go to `10`
    // const rowWidth = rowWidthOverride ? rowWidthOverride : 10;
    // var rows: string[][] = arrayChunk(ops, rowWidth);

    var imgSize = (imgSizeOverride === undefined) ? 32 : imgSizeOverride;

    return tileListComponent(ops, (opName) => <>
      <img src={operatorsIndexReactive.getOperatorIconPath(opName)} width="256" height="256" style={{ margin: 0, width: imgSize, height: imgSize }} alt="" />
      {includeNames ? <p>{opName}</p> : undefined}
    </>, onClick, rowWidthOverride)
  }

  function connectToServerPageComponent() {
    async function connectToServer(ipAddr: string) {
      let ws = await WebSocket.connect(`ws://${ipAddr}`);
      websocket = ws;

      ws.addListener((msg) => {
        handleNetworkMessage(msg);
      })

      // ws
      // ws.addListener((msg) => {
      //   switch (msg.type) {
      //     case "Text":
      //       println("Network messages must be in binary!");
      //       break;
      //     case "Binary":
      //       handleNetworkMessage(Uint8Array.from(msg.data));
      //       break;
      //     case "Ping":
      //       break;
      //     case "Pong":
      //       break;
      //     case "Close":
      //       break;
      //   }
      // });
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
      stratEditingState.stratId = stratMeta.uuid;
      stratEditingState.map = stratMeta.map;
      stratEditingState.mode = StratEditingMode.Singleplayer;
      updateStratEditingStateDisplay();
      await sendNetworkMessage(protos.Client2Server.create({ getStratInfo: { stratId: stratMeta.uuid } }));
      await sendNetworkMessage(protos.Client2Server.create({ getMapMetadata: { map: stratMeta.map } }));
    }

    return (<>
      <button onClick={(_) => {
        sendNetworkMessage(protos.Client2Server.create({ getLobbyList: {} }));
        setCurrPage(Page.LobbyListPage);
      }} style={{ width: "fit-content" }}>Join Lobby</button>
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
          }}>Edit</button>
        </div>
      )}
    </>)
  }

  function lobbyListPageComponent() {
    return (<>
      <button onClick={(_) => {
        sendNetworkMessage(protos.Client2Server.create({ getStratList: {} }));
        setCurrPage(Page.StratListPage);
      }}>Edit Strat</button>
      <button onClick={(_) => {
        sendNetworkMessage(protos.Client2Server.create({ createLobby: {} }));
      }}>Create Lobby</button>
      {lobbyList.map((host) => <>
        <button key={host} onClick={(_) => {
          sendNetworkMessage(protos.Client2Server.create({ joinLobby: { host } }))
        }}>{host}</button>
      </>)}
    </>);
  }

  function inLobbySelectStratPageComponent() {
    return (<>
      <div className="col" style={{ border: "2px solid #0f0f0f", borderRadius: "8px" }}>
        <p>Lobby members: </p>
        {stratEditingStateDisplay.lobbyMembers.map((memberName) => <>
          <p>{memberName}</p>
        </>)}
      </div>
      <p>Select a strat!</p>
    </>)
  }

  function createNewStratMapSelectionPageComponent() {
    async function createNewStrat(map: string) {
      stratEditingState.map = map;
      stratEditingState.mode = StratEditingMode.Singleplayer;
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

      const caretDown = carets < 0;
      const numCarets = Math.abs(carets);

      const canvas = document.getElementById(canvasId);
      if (canvas == null) {
        return;
      }

      const ctx = (canvas as HTMLCanvasElement).getContext("2d");
      if (ctx == null) {
        return;
      }

      const length = 5;
      const lineWidth = 1.5;
      const spacing = 3;

      function drawSingleCaret(ctx: CanvasRenderingContext2D, isDown: boolean, pos: Vec2) {
        // Since -y is "up", we rotate in the positive direction to point downwards
        let offsetRight = new Vec2(1, 0).rotated(0.4).scaled(length);
        if (isDown) {
          offsetRight = new Vec2(offsetRight.x, -offsetRight.y);
        }
        let offsetLeft = new Vec2(-offsetRight.x, offsetRight.y);

        let ptLeft = offsetRight.add(pos);
        let ptRight = offsetLeft.add(pos);

        ctx.beginPath();
        ctx.strokeStyle = "blue";
        ctx.lineWidth = lineWidth;

        ctx.moveTo(ptLeft.x, ptLeft.y);
        ctx.lineTo(pos.x, pos.y);
        ctx.lineTo(ptRight.x, ptRight.y);

        ctx.stroke();
        ctx.closePath();
      }

      if (numCarets == 1) {
        drawSingleCaret(ctx, caretDown, pos);
      } else {
        const offsetMax = 0.5 * numCarets * spacing;

        for (let caret = 0; caret < numCarets; caret += 1) {
          const posY = pos.y + lerp(-offsetMax, offsetMax, caret / (numCarets - 1));
          drawSingleCaret(ctx, caretDown, new Vec2(pos.x, posY));
        }
      }
    }

    function drawElementToCanvas(canvasId: string, elem: DrawElement, floor: number) {
      const canvas = document.getElementById(canvasId);
      if (canvas == null) {
        return;
      }

      const ctx = (canvas as HTMLCanvasElement).getContext("2d");
      if (ctx == null) {
        return;
      }

      if (stratEditingState.selectedFloor != floor) {
        ctx.globalAlpha = 0.3;
      }
      elem.drawToCtx(ctx);
      ctx.globalAlpha = 1.0;

      const aabb = elem.boundingBox();
      const caretPt = new Vec2(aabb.minPt.x, (aabb.minPt.y + aabb.maxPt.y) / 2);
      drawCaretToCanvas(canvasId, floor - stratEditingState.selectedFloor, caretPt);
    }

    function redrawFreeDrawCanvas(canvasId: string) {
      const canvas = document.getElementById(canvasId)! as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const phase = stratEditingState.getPhasesRef()[stratEditingState.selectedPhase];

      if (!phase) {
        return;
      }

      let floorPriorityOrdering = [];
      for (let i = 0; i < stratEditingState.mapFloors.length; i += 1) {
        if (i != stratEditingState.selectedFloor) {
          floorPriorityOrdering.push(i);
        }
      }

      for (let floorIdx = 0; floorIdx < stratEditingState.mapFloors.length; floorIdx += 1) {
        const phaseFloor = phase.floors[floorIdx];
        if (phaseFloor) {
          phaseFloor.drawPaths.forEach((path) => {
            drawElementToCanvas(canvasId, path, floorIdx);
          });
          phaseFloor.arrows.forEach((arrow) => {
            drawElementToCanvas(canvasId, arrow, floorIdx);
          });
          phaseFloor.icons.forEach((icon) => {
            drawElementToCanvas(canvasId, icon, floorIdx);
          });
        }
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
        ></canvas>
      )
    }

    function inputGatheringCanvas() {
      const inputGatheringCanvasId = "input-gathering-canvas";

      function onUpdate() {
        if (document.getElementById(stratEditorFreeDrawCanvasId) && redrawFreeDrawCanvasQueued) {
          redrawFreeDrawCanvasQueued = false;
          redrawFreeDrawCanvas(stratEditorFreeDrawCanvasId);
        }

        const phase = stratEditingState.selectedPhase;
        const floor = stratEditingState.selectedFloor;
        if (!stratEditingState.currentPhaseFloorIsValid()) {
          return;
        }

        const placementPreviewCanvas = document.getElementById(placementPreviewCanvasId)! as HTMLCanvasElement;
        const placementPreviewCtx = placementPreviewCanvas.getContext("2d")!;
        placementPreviewCtx.clearRect(0, 0, placementPreviewCanvas.width, placementPreviewCanvas.height);


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
              const prevColor = stratEditingState.getDrawElementRef(phase, floor, toolState.currentPath!)?.asDrawPath()?.color;

              if (toolState.currentPath && prevColor! == stratEditingState.selectedDrawColor) {
                // Continue existing path
                if (inputCanvasState.mousePos.distance(inputCanvasState.prevMousePos) > 0.001) {
                  const elem = stratEditingState.getDrawElementRef(phase, floor, toolState.currentPath!)?.asDrawPath();
                  if (elem) {
                    elem.points.push(inputCanvasState.mousePos.clone());
                    // TODO: only call `setDrawElement` on *finishing* a path
                    stratEditingState.setDrawElement(phase, floor, toolState.currentPath!, elem);
                  }
                }
              } else {
                // Create new path
                var path = new DrawPath([inputCanvasState.mousePos.clone()], stratEditingState.selectedDrawColor);
                const id = stratEditingState.pushDrawElement(phase, floor, path);
                stratEditingState.pushPreviousDrawAction(stratEditingState.selectedPhase, {
                  kind: DrawActionKind.PlaceDrawElement,
                  data: path,
                  floor: stratEditingState.selectedFloor,
                  id,
                });
                toolState.currentPath = id;
              }

              // Draw path to canvas immediately, avoiding a rerender
              if (inputCanvasState.prevMouseClicked) {
                var path = new DrawPath([inputCanvasState.prevMousePos.clone(), inputCanvasState.mousePos.clone()], stratEditingState.selectedDrawColor);
                drawElementToCanvas(stratEditorFreeDrawCanvasId, path, stratEditingState.selectedFloor);
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
                const arrow = new Arrow(toolState.arrowStartPoint.clone(), inputCanvasState.mousePos.clone(), stratEditingState.selectedDrawColor);
                drawElementToCanvas(stratEditorFreeDrawCanvasId, arrow, stratEditingState.selectedFloor);
                const id = stratEditingState.pushDrawElement(phase, floor, arrow);
                stratEditingState.pushPreviousDrawAction(stratEditingState.selectedPhase, {
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
              const arrow = new Arrow(toolState.arrowStartPoint.clone(), inputCanvasState.mousePos.clone(), stratEditingState.selectedDrawColor);
              drawElementToCanvas(placementPreviewCanvasId, arrow, stratEditingState.selectedFloor);
            }
            break;
          }
          case DrawTool.PlaceIcon: {
            const toolState = stratEditingState.toolStates.placeIcon;

            let iconSize;
            switch (toolState.selectedIcon.kind) {
              case IconKind.TeamOperator: {
                iconSize = 50;
                break;
              }
              case IconKind.TeamAbility: {
                iconSize = 30;
                break;
              }
              case IconKind.TeamUtility: {
                iconSize = 30;
                break;
              }
              case IconKind.FreeOperator: {
                iconSize = 50;
                break;
              }
              case IconKind.FreeAbility: {
                iconSize = 30;
                break;
              }
              case IconKind.FreeUtility: {
                iconSize = 30;
                break;
              }
            }

            const icon = new IconPlacement(inputCanvasState.mousePos.clone(), iconSize, toolState.selectedIcon);

            if (inputCanvasState.mouseClicked && !inputCanvasState.prevMouseClicked) {
              drawElementToCanvas(stratEditorFreeDrawCanvasId, icon, stratEditingState.selectedFloor);
              const id = stratEditingState.pushDrawElement(phase, floor, icon);
              stratEditingState.pushPreviousDrawAction(stratEditingState.selectedPhase, {
                kind: DrawActionKind.PlaceDrawElement,
                data: icon,
                floor: stratEditingState.selectedFloor,
                id,
              });
            } else {
              drawElementToCanvas(placementPreviewCanvasId, icon, stratEditingState.selectedFloor);
            }
            break;
          }
          case DrawTool.SelectAndEdit: {
            const toolState = stratEditingState.toolStates.selectAndEdit;
            const phase = stratEditingState.selectedPhase;
            const phaseRawRef = stratEditingState.getPhasesRef()[stratEditingState.selectedPhase];

            const prevSelected = toolState.selected?.clone();

            // Clear invalid selected item
            if (toolState.selected) {
              switch (toolState.selected.kind) {
                case DrawElementKind.DrawPath: {
                  const path = phaseRawRef.floors[toolState.selected.floor].drawPaths.get(toolState.selected.id);
                  if (!path) {
                    toolState.selected = undefined;
                  }
                  break;
                }
                case DrawElementKind.Arrow: {
                  const arrow = phaseRawRef.floors[toolState.selected.floor].arrows.get(toolState.selected.id);
                  if (!arrow) {
                    toolState.selected = undefined;
                  }
                  break;
                }
                case DrawElementKind.Icon: {
                  const icon = phaseRawRef.floors[toolState.selected.floor].icons.get(toolState.selected.id);
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
                for (const id of phaseRawRef.floors[floor].allDrawElements().slice().reverse()) {
                  const item = phaseRawRef.floors[floor].getDrawElement(id);
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

            if (toolState.selected && toolState.selected.get(phaseRawRef)) {
              // Draw border around selection
              const boundingBox: Aabb = toolState.selected.get(phaseRawRef)!.boundingBox();

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
                  stratEditingState.pushPreviousDrawAction(phase, {
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
                const drawElem = toolState.selected.get(phaseRawRef)!;
                drawElem.mapPoints((pt) => pt.add(posDelta));
                toolState.currDragTotalDelta = toolState.currDragTotalDelta.add(posDelta);
                stratEditingState.setDrawElement(phase, toolState.selected.floor, toolState.selected.id, drawElem);

                // Somehow this isn't *that* bad for performance??
                redrawFreeDrawCanvas(stratEditorFreeDrawCanvasId);
              }

              // Delete the selection
              if (toolState.isDeleteQueued) {
                stratEditingState.pushPreviousDrawAction(phase, {
                  kind: DrawActionKind.DeleteDrawElement,
                  data: toolState.selected.get(phaseRawRef)!,
                  floor: toolState.selected.floor,
                  id: toolState.selected.id,
                });
                stratEditingState.deleteDrawElement(phase, toolState.selected.floor, toolState.selected.id);
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
        const previousDrawActionsList = stratEditingState.getPreviousDrawActionsRef(stratEditingState.selectedPhase);
        if (!previousDrawActionsList) {
          return;
        }

        if (previousDrawActionsList.length == 0) {
          return;
        }

        const previousDrawAction = previousDrawActionsList.pop()!;

        const phase = stratEditingState.selectedPhase;
        const floor = previousDrawAction.floor;
        const id = previousDrawAction.id;

        // Update redo stack
        {
          const phase = stratEditingState.getPhasesRef()[stratEditingState.selectedPhase];
          phase.redoStack.push(previousDrawAction);
        }

        switch (previousDrawAction.kind) {
          case DrawActionKind.PlaceDrawElement: {
            stratEditingState.deleteDrawElement(phase, floor, id);
            if (previousDrawAction.data.asEnum().kind = DrawElementKind.DrawPath) {
              stratEditingState.toolStates.freeDraw.currentPath = undefined;
            }
            break;
          }
          case DrawActionKind.DeleteDrawElement: {
            stratEditingState.setDrawElement(phase, floor, id, previousDrawAction.data);
            break;
          }
          case DrawActionKind.MoveDrawElement: {
            const elem = stratEditingState.getDrawElementRef(phase, floor, id);
            if (elem) {
              elem.mapPoints((pt) => pt.sub(previousDrawAction.delta));
              stratEditingState.setDrawElement(phase, floor, id, elem);
            }
            break;
          }
        }
        redrawFreeDrawCanvas(stratEditorFreeDrawCanvasId);
      }

      function triggerRedo() {
        const phase = stratEditingState.selectedPhase;

        let redoAction = undefined;
        {
          const phaseRef = stratEditingState.getPhasesRef()[phase];
          if (!phaseRef) {
            return;
          }
          redoAction = phaseRef.redoStack.pop();
          if (!redoAction) {
            return;
          }
          phaseRef.getPreviousDrawActionsRef().push(redoAction);
        }

        switch (redoAction.kind) {
          case DrawActionKind.PlaceDrawElement: {
            stratEditingState.setDrawElement(phase, redoAction.floor, redoAction.id, redoAction.data);
            drawElementToCanvas(stratEditorFreeDrawCanvasId, redoAction.data, stratEditingState.selectedFloor);
            break;
          }
          case DrawActionKind.DeleteDrawElement: {
            stratEditingState.deleteDrawElement(phase, redoAction.floor, redoAction.id);
            redrawFreeDrawCanvas(stratEditorFreeDrawCanvasId);
            break;
          }
          case DrawActionKind.MoveDrawElement: {
            const elem = stratEditingState.getDrawElementRef(phase, redoAction.floor, redoAction.id);
            if (elem) {
              elem.mapPoints((pt) => pt.add(redoAction.delta));
              stratEditingState.setDrawElement(phase, redoAction.floor, redoAction.id, elem);
              redrawFreeDrawCanvas(stratEditorFreeDrawCanvasId);
            }
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
          style={{ gridColumn: 1, gridRow: 1, zIndex: 100, touchAction: "none" }}
          // style={{ gridColumn: 1, gridRow: 1, zIndex: 100 }}
          width={stratEditingStateDisplay.mapImgWidth}
          height={stratEditingStateDisplay.mapImgHeight}
          onMouseEnter={(_e) => inputCanvasState.mouseClicked = false}
          onMouseLeave={(_e) => inputCanvasState.mouseClicked = false}
          onMouseDown={(_e) => inputCanvasState.mouseClicked = true}
          onMouseUp={(_e) => inputCanvasState.mouseClicked = false}
          // onMouseEnter={(e) => { inputCanvasState.mouseClicked = false; e.preventDefault(); }}
          // onMouseLeave={(e) => { inputCanvasState.mouseClicked = false; e.preventDefault(); }}
          // onMouseDown={(e) => { inputCanvasState.mouseClicked = true; e.preventDefault(); }}
          // onMouseUp={(e) => { inputCanvasState.mouseClicked = false; e.preventDefault(); }}
          onMouseMove={(e) => {
            e.preventDefault();
            inputCanvasState.mousePos = mousePosForCanvas(inputGatheringCanvasId, e.clientX, e.clientY);
          }}></canvas>
      </>)
    }

    async function saveProgress() {
      const phases: protos.StratPhase[] = stratEditingState.getPhasesRef().map((phase) => {
        return {
          phaseName: phase.phaseName, floors: phase.floors.map((floor) => {
            return {
              drawPaths: mapMapToObject(floor.drawPaths, (id, path) => {
                return [id.data, { points: path.points, color: colorToProto(path.color) }]
              }),
              arrows: mapMapToObject(floor.arrows, (id, arrow) => {
                return [id.data, { start: arrow.start, end: arrow.end, color: colorToProto(arrow.color) }]
              }),
              icons: mapMapToObject(floor.icons, (id, icon) => {
                let protoIcon = { pos: icon.pos };
                switch (icon.info.kind) {
                  case IconKind.TeamOperator: {
                    Object.assign(protoIcon, { teamOperator: { teammateIdx: icon.info.teammateIndex } })
                    break;
                  }
                  case IconKind.TeamAbility: {
                    Object.assign(protoIcon, { teamAbility: { teammateIdx: icon.info.teammateIndex } })
                    break;
                  }
                  case IconKind.TeamUtility: {
                    Object.assign(protoIcon, { teamUtility: { teammateIdx: icon.info.teammateIndex } })
                    break;
                  }
                  case IconKind.FreeOperator: {
                    Object.assign(protoIcon, { freeOperator: { operator: icon.info.operator } })
                    break;
                  }
                  case IconKind.FreeAbility: {
                    Object.assign(protoIcon, { freeAbility: { ability: icon.info.operator } })
                    break;
                  }
                  case IconKind.FreeUtility: {
                    Object.assign(protoIcon, { freeUtility: { util: icon.info.util } })
                    break;
                  }
                }
                return [id.data, protoIcon]
              }),
            };
          })
        };
      });
      const teammates: protos.Teammate[] = stratEditingState.teamLoadouts.map((loadout) => {
        return { operator: loadout.operator, color: { r: loadout.color[0], g: loadout.color[1], b: loadout.color[2] }, util: loadout.util }
      });

      const state: protos.StratState = { stratName: stratEditingState.stratName, phases, teammates };

      await sendNetworkMessage(protos.Client2Server.create({ saveStrat: { stratId: stratEditingState.stratId, state: state } }));
    }

    return (
      <>
        {/* Menuing buttons */}
        <button onClick={(_) => {
          let gotoStratList = () => {
            stratEditingState.reset();
            updateStratEditingStateDisplay();
            sendNetworkMessage(protos.Client2Server.create({ getStratList: {} }));
            setCurrPage(Page.StratListPage);
          };
          switch (stratEditingState.mode) {
            case StratEditingMode.Singleplayer: {
              saveProgress().then(gotoStratList);
              break;
            }
            case StratEditingMode.Lobby: {
              gotoStratList();
              break;
            }
          }
        }}>Back to Strat list</button>

        {stratEditingStateDisplay.mode == StratEditingMode.Singleplayer && (<button onClick={(_) => {
          saveProgress()
        }}>Save Progress</button>)}

        {/* Lobby members display */}
        {stratEditingStateDisplay.mode == StratEditingMode.Lobby && (<>
          <p>Lobby Members</p>
          {stratEditingStateDisplay.lobbyMembers.forEach((member) =>
            <p>{member}</p>
          )}
        </>)}

        {/* Edit strat name */}
        <div className="row">
          <p>Title: </p>
          <input
            value={stratEditingStateDisplay.stratName}
            onChange={(e) => {
              stratEditingState.stratName = e.target.value;
              updateStratEditingStateDisplay();
            }} />
        </div>

        {/* Edit current phase name & select phase */}
        <div className="row">
          <p>Current Phase: </p>
          <input
            value={stratEditingStateDisplay.getPhasesRef()[stratEditingState.selectedPhase]?.phaseName}
            onChange={(e) => {
              stratEditingState.setPhaseName(stratEditingState.selectedPhase, e.target.value);
              updateStratEditingStateDisplay();
            }} />
        </div>
        <div className="row">
          {stratEditingStateDisplay.getPhasesRef().map((phase, i) =>
            <button key={i} onClick={(e) => {
              e.preventDefault();
              stratEditingState.selectedPhase = i;

              stratEditingState.toolStates.arrow = new ArrowToolState();
              stratEditingState.toolStates.freeDraw = new FreeDrawToolState();
              // Don't clear icon placement state
              stratEditingState.toolStates.selectAndEdit = new SelectAndEditToolState();
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
        <p>Current Floor: {stratEditingStateDisplay.mapFloors[stratEditingStateDisplay.selectedFloor]}</p>
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
                stratEditingState.toolStates.placeIcon.selectedIcon = { kind: IconKind.TeamOperator, teammateIndex: idx };
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
                      stratEditingState.teamLoadouts[idx].util = "";
                      setSelectOperatorForTeammateActiveIdx(undefined);

                      updateStratEditingStateDisplay();
                      redrawFreeDrawCanvas(stratEditorFreeDrawCanvasId);
                    }, false, true, false, 10)}
                  </div>
                </div>
              )}
              <button style={{ paddingTop: 4, paddingBottom: 4, paddingLeft: 0, paddingRight: 0, height: 56 }} onClick={(_e) => {
                stratEditingState.selectedDrawTool = DrawTool.PlaceIcon;
                stratEditingState.toolStates.placeIcon.selectedIcon = { kind: IconKind.TeamAbility, teammateIndex: idx };
                updateStratEditingStateDisplay();
              }}>
                <img
                  src={operatorsIndexReactive.getOperatorAbilityIconPath(loadout.operator)}
                  style={OperatorsIndex.abilityImgDataStyle}
                />
              </button>

              <button style={{ paddingTop: 4, paddingBottom: 4, paddingLeft: 0, paddingRight: 0, height: 56 }} onClick={(_e) => {
                stratEditingState.selectedDrawTool = DrawTool.PlaceIcon;
                stratEditingState.toolStates.placeIcon.selectedIcon = { kind: IconKind.TeamUtility, teammateIndex: idx };
                updateStratEditingStateDisplay();
              }}>
                <img
                  src={operatorsIndexReactive.getUtilityIconPath(loadout.util)}
                  style={OperatorsIndex.abilityImgDataStyle}
                />
              </button>
              <button onClick={(_e) => {
                if (selectUtilityForTeammateActiveIdx == idx) {
                  setSelectUtilityForTeammateActiveIdx(undefined);
                } else {
                  setSelectUtilityForTeammateActiveIdx(idx);
                }
              }}>Select Utility</button>
              {selectUtilityForTeammateActiveIdx == idx && (
                <div style={{ position: "relative", zIndex: 1000, padding: 0 }}>
                  <div style={{ position: "absolute", zIndex: 1001, top: "32px", left: "-50%", backgroundColor: "#bababa", border: "2px solid #0f0f0f", borderRadius: "8px" }}>
                    {utilityTileListComponent((util) => {
                      stratEditingState.teamLoadouts[idx].util = util;
                      setSelectUtilityForTeammateActiveIdx(undefined);

                      updateStratEditingStateDisplay();
                      redrawFreeDrawCanvas(stratEditorFreeDrawCanvasId);
                    }, stratEditingState.teamLoadouts[idx].operator)}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Toolbar and draw area */}
        <div className="row" style={{ justifyItems: "left" }}>
          {/* Toolbar */}
          <div className="col" id="tool-selector-bar" style={{ margin: 8 }}>
            <p>{DrawTool[stratEditingState.selectedDrawTool]}</p>
            <div style={{ border: "2px solid #0f0f0f", borderRadius: "8px" }}>
              {tileListComponent(StratEditingState.freeDrawPalette, (color) => <>
                <div style={{
                  width: 32,
                  height: 32,
                  border: stratEditingStateDisplay.selectedDrawColor == color ? "2px solid #0f0f0f" : "",
                  backgroundColor: `rgb(${color[0]}, ${color[1]}, ${color[2]})`,
                  borderRadius: "8px"
                }}></div>
              </>, (color) => {
                stratEditingState.selectedDrawColor = color;
                updateStratEditingStateDisplay();
              }, 3)}
            </div>
            <button onClick={(_) => { stratEditingState.selectedDrawTool = DrawTool.SelectAndEdit; updateStratEditingStateDisplay(); }}>Select and edit</button>
            <button onClick={(_) => { stratEditingState.selectedDrawTool = DrawTool.FreeDraw; updateStratEditingStateDisplay(); }}>Free draw</button>
            <button onClick={(_) => { stratEditingState.selectedDrawTool = DrawTool.Arrow; updateStratEditingStateDisplay(); }}>Arrow</button>
            <div style={{ border: "2px solid #0f0f0f", borderRadius: "8px" }}>
              {operatorTileListComponent((operator) => {
                stratEditingState.selectedDrawTool = DrawTool.PlaceIcon;
                stratEditingState.toolStates.placeIcon.selectedIcon = { kind: IconKind.FreeOperator, operator };
                updateStratEditingStateDisplay();
              }, false, true, true, 6)}
            </div>
            <div style={{ border: "2px solid #0f0f0f", borderRadius: "8px" }}>
              {utilityTileListComponent((util) => {
                stratEditingState.selectedDrawTool = DrawTool.PlaceIcon;
                stratEditingState.toolStates.placeIcon.selectedIcon = { kind: IconKind.FreeUtility, util };
                updateStratEditingStateDisplay();
              }, undefined, 6)}
            </div>

          </div>

          {/* Draw Area */}
          <div id="draw-area" style={{ margin: 8, display: "grid", gridTemplateColumns: "1", gridTemplateRows: "1" }}>
            <img src={getFloorImgPath(stratEditingStateDisplay.map, stratEditingStateDisplay.mapFloors[stratEditingStateDisplay.selectedFloor])}
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
      case Page.LobbyListPage:
        return lobbyListPageComponent()
      case Page.InLobbySelectStratPage:
        return inLobbySelectStratPageComponent()
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
