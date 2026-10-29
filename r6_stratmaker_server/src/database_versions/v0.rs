use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fmt::Display};
use uuid::Uuid;

#[derive(Debug, Clone, Copy)]
pub enum DBKeyspaceId {
    Users,
    Strats,
}

impl DBKeyspaceId {
    pub fn name(self) -> &'static str {
        match self {
            DBKeyspaceId::Users => "users",
            DBKeyspaceId::Strats => "strategies",
        }
    }
}

pub trait DBKeyspace {
    type Key: Serialize + for<'a> Deserialize<'a> + Send;
    type Entry: Default + Serialize + for<'a> Deserialize<'a> + Send + 'static;

    fn keyspace_id() -> DBKeyspaceId;
}

pub struct UsersKeyspace;
impl DBKeyspace for UsersKeyspace {
    type Key = Username;

    type Entry = UsersEntry;

    fn keyspace_id() -> DBKeyspaceId {
        DBKeyspaceId::Users
    }
}

pub struct StratsKeyspace;
impl DBKeyspace for StratsKeyspace {
    type Key = StratId;

    type Entry = StratEntry;

    fn keyspace_id() -> DBKeyspaceId {
        DBKeyspaceId::Strats
    }
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Username(pub String);

impl Display for Username {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        Display::fmt(&self.0, f)
    }
}

#[derive(Deserialize, Serialize, Default, Debug)]
pub struct UsersEntry {
    pub strats: Vec<StratId>,
}

#[derive(Deserialize, Serialize, Debug, Default, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq)]
pub struct StratId(pub Uuid);

#[derive(Deserialize, Serialize, Default, Debug, Clone)]
pub struct DrawPath {
    pub points: Vec<Point>,
    pub color: Color,
}

#[derive(Deserialize, Serialize, Default, Debug, Clone)]
pub struct Arrow {
    pub start: Point,
    pub end: Point,
    pub color: Color,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub enum IconKind {
    TeamOperator { teammate_idx: u32 },
    TeamAbility { teammate_idx: u32 },
    TeamUtility { teammate_idx: u32 },
    FreeOperator { operator: String },
    FreeAbility { ability: String },
    FreeUtility { util: String },

    Reinforcement,
    Defuser,
    Barricade,

    RunnableRotate,
    FootHole,
    HeadHole,
    VaultHole,
}

impl Default for IconKind {
    fn default() -> Self {
        IconKind::TeamOperator { teammate_idx: 0 }
    }
}

#[derive(Deserialize, Serialize, Default, Debug, Clone)]
pub struct PlacedIcon {
    pub pos: Point,
    pub kind: IconKind,
}

#[derive(Deserialize, Serialize, Default, Debug, Clone)]
pub struct PhaseFloor {
    pub draw_paths: HashMap<String, DrawPath>,
    pub arrows: HashMap<String, Arrow>,
    pub icons: HashMap<String, PlacedIcon>,
}

#[derive(Deserialize, Serialize, Default, Debug, Clone)]
pub struct StratPhase {
    pub phase_name: String,
    pub floors: Vec<PhaseFloor>,
}

#[derive(Deserialize, Serialize, Default, Debug, Clone)]
pub struct Color {
    pub r: f64,
    pub g: f64,
    pub b: f64,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Teammate {
    pub operator: String,
    pub util: String,
    pub color: Color,
}

impl Default for Teammate {
    fn default() -> Self {
        Self {
            operator: "ace".into(),
            util: "".into(),
            color: Color::default(),
        }
    }
}

#[derive(Deserialize, Serialize, Default, Debug, Clone)]
pub struct StratEntry {
    pub strat_name: String,
    pub map: String,
    pub teammates: Vec<Teammate>,
    pub phases: Vec<StratPhase>,
}
