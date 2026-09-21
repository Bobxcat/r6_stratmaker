use std::{collections::HashMap, fmt::Display};

use anyhow::Error;
use fjall::{Database, Keyspace, KeyspaceCreateOptions};
use json::JsonValue;
use protobuf::{MessageField, SpecialFields};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::protos;

pub trait DBKeyspace {
    type Key: Serialize + for<'a> Deserialize<'a> + Send;
    type Entry: Default + Serialize + for<'a> Deserialize<'a> + Send + 'static;

    fn keyspace_id() -> DBKeyspaceId;
}

pub trait ProtoConvert {
    type Proto;

    fn from_proto(proto: Self::Proto) -> Self;
    fn to_proto(self) -> Self::Proto;
}

pub struct UsersKeyspace;

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

impl DBKeyspace for UsersKeyspace {
    type Key = Username;

    type Entry = UsersEntry;

    fn keyspace_id() -> DBKeyspaceId {
        DBKeyspaceId::Users
    }
}

pub struct StratsKeyspace;

#[derive(Deserialize, Serialize, Debug, Default, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub fn from_proto(proto: protos::primary::Point) -> Self {
        Self {
            x: proto.x,
            y: proto.y,
        }
    }
    pub fn to_proto(self) -> protos::primary::Point {
        protos::primary::Point {
            x: self.x,
            y: self.y,
            special_fields: SpecialFields::new(),
        }
    }
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq)]
pub struct StratId(pub Uuid);

impl StratId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    pub fn to_string(&self) -> String {
        format!("{}", self.0)
    }

    pub fn from_str(input: &str) -> Result<Self, uuid::Error> {
        Ok(Self(Uuid::try_parse(input)?))
    }
}

#[derive(Deserialize, Serialize, Default, Debug)]
pub struct DrawPath {
    pub points: Vec<Point>,
    pub color: Color,
}

impl ProtoConvert for DrawPath {
    type Proto = protos::primary::DrawPath;

    fn from_proto(proto: Self::Proto) -> Self {
        Self {
            points: proto.points.into_iter().map(Point::from_proto).collect(),
            color: Color::from_proto(proto.color.unwrap()),
        }
    }

    fn to_proto(self) -> Self::Proto {
        Self::Proto {
            points: self.points.into_iter().map(Point::to_proto).collect(),
            color: MessageField::some(self.color.to_proto()),
            special_fields: SpecialFields::new(),
        }
    }
}

#[derive(Deserialize, Serialize, Default, Debug)]
pub struct Arrow {
    pub start: Point,
    pub end: Point,
    pub color: Color,
}

impl ProtoConvert for Arrow {
    type Proto = protos::primary::Arrow;

    fn from_proto(proto: Self::Proto) -> Self {
        Self {
            start: Point::from_proto(proto.start.unwrap()),
            end: Point::from_proto(proto.end.unwrap()),
            color: Color::from_proto(proto.color.unwrap()),
        }
    }

    fn to_proto(self) -> Self::Proto {
        Self::Proto {
            start: MessageField::some(self.start.to_proto()),
            end: MessageField::some(self.end.to_proto()),
            color: MessageField::some(self.color.to_proto()),
            special_fields: SpecialFields::new(),
        }
    }
}

#[derive(Deserialize, Serialize, Debug)]
pub enum IconKind {
    TeamOperator { teammate_idx: u32 },
    TeamAbility { teammate_idx: u32 },
    TeamUtility { teammate_idx: u32 },
    FreeOperator { operator: String },
    FreeAbility { ability: String },
    FreeUtility { util: String },
}

impl Default for IconKind {
    fn default() -> Self {
        IconKind::TeamOperator { teammate_idx: 0 }
    }
}

#[derive(Deserialize, Serialize, Default, Debug)]
pub struct PlacedIcon {
    pub pos: Point,
    pub kind: IconKind,
}

impl ProtoConvert for PlacedIcon {
    type Proto = protos::primary::Icon;

    fn from_proto(proto: Self::Proto) -> Self {
        Self {
            pos: Point::from_proto(proto.pos.unwrap()),
            kind: match proto.IconKind.unwrap() {
                protos::primary::icon::IconKind::TeamOperator(team_operator) => {
                    IconKind::TeamOperator {
                        teammate_idx: team_operator.teammateIdx,
                    }
                }
                protos::primary::icon::IconKind::TeamAbility(team_ability) => {
                    IconKind::TeamAbility {
                        teammate_idx: team_ability.teammateIdx,
                    }
                }
                protos::primary::icon::IconKind::TeamUtility(team_utility) => {
                    IconKind::TeamUtility {
                        teammate_idx: team_utility.teammateIdx,
                    }
                }
                protos::primary::icon::IconKind::FreeOperator(free_operator) => {
                    IconKind::FreeOperator {
                        operator: free_operator.operator,
                    }
                }
                protos::primary::icon::IconKind::FreeAbility(free_ability) => {
                    IconKind::FreeAbility {
                        ability: free_ability.ability,
                    }
                }
                protos::primary::icon::IconKind::FreeUtility(free_utility) => {
                    IconKind::FreeUtility {
                        util: free_utility.util,
                    }
                }
            },
        }
    }

    fn to_proto(self) -> Self::Proto {
        Self::Proto {
            pos: MessageField::some(self.pos.to_proto()),
            IconKind: Some(match self.kind {
                IconKind::TeamOperator { teammate_idx } => {
                    protos::primary::icon::IconKind::TeamOperator(
                        protos::primary::icon::TeamOperator {
                            teammateIdx: teammate_idx,
                            special_fields: SpecialFields::new(),
                        },
                    )
                }
                IconKind::TeamAbility { teammate_idx } => {
                    protos::primary::icon::IconKind::TeamAbility(
                        protos::primary::icon::TeamAbility {
                            teammateIdx: teammate_idx,
                            special_fields: SpecialFields::new(),
                        },
                    )
                }
                IconKind::TeamUtility { teammate_idx } => {
                    protos::primary::icon::IconKind::TeamUtility(
                        protos::primary::icon::TeamUtility {
                            teammateIdx: teammate_idx,
                            special_fields: SpecialFields::new(),
                        },
                    )
                }
                IconKind::FreeOperator { operator } => {
                    protos::primary::icon::IconKind::FreeOperator(
                        protos::primary::icon::FreeOperator {
                            operator,
                            special_fields: SpecialFields::new(),
                        },
                    )
                }
                IconKind::FreeAbility { ability } => protos::primary::icon::IconKind::FreeAbility(
                    protos::primary::icon::FreeAbility {
                        ability,
                        special_fields: SpecialFields::new(),
                    },
                ),
                IconKind::FreeUtility { util } => protos::primary::icon::IconKind::FreeUtility(
                    protos::primary::icon::FreeUtility {
                        util,
                        special_fields: SpecialFields::new(),
                    },
                ),
            }),
            special_fields: SpecialFields::new(),
        }
    }
}

#[derive(Deserialize, Serialize, Default, Debug)]
pub struct PhaseFloor {
    pub draw_paths: HashMap<String, DrawPath>,
    pub arrows: HashMap<String, Arrow>,
    pub icons: HashMap<String, PlacedIcon>,
}

#[derive(Deserialize, Serialize, Default, Debug)]
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

impl ProtoConvert for Color {
    type Proto = protos::primary::Color;

    fn from_proto(color: Self::Proto) -> Self {
        Self {
            r: color.r,
            g: color.g,
            b: color.b,
        }
    }

    fn to_proto(self) -> Self::Proto {
        Self::Proto {
            r: self.r,
            g: self.g,
            b: self.b,
            special_fields: SpecialFields::new(),
        }
    }
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

#[derive(Deserialize, Serialize, Default, Debug)]
pub struct StratEntry {
    pub strat_name: String,
    pub map: String,
    pub teammates: Vec<Teammate>,
    pub phases: Vec<StratPhase>,
}

impl DBKeyspace for StratsKeyspace {
    type Key = StratId;

    type Entry = StratEntry;

    fn keyspace_id() -> DBKeyspaceId {
        DBKeyspaceId::Strats
    }
}

#[derive(Debug, Clone, Copy)]
pub enum DBKeyspaceId {
    Users,
    Strats,
}

#[derive(Clone)]
pub struct DatabaseHandle {
    #[allow(unused)]
    database: Database,
    users: Keyspace,
    strategies: Keyspace,
}

impl DatabaseHandle {
    /// ONLY CALL ONCE! Or rather, only have one instance active!
    pub async fn initialize() -> Result<Self, Error> {
        let database = Database::builder(".fjall_database").open()?;
        Ok(Self {
            users: database.keyspace("users", KeyspaceCreateOptions::default)?,
            strategies: database.keyspace("strategies", KeyspaceCreateOptions::default)?,
            database,
        })
    }

    fn get_keyspace(&self, keyspace: DBKeyspaceId) -> &Keyspace {
        match keyspace {
            DBKeyspaceId::Users => &self.users,
            DBKeyspaceId::Strats => &self.strategies,
        }
    }

    pub async fn get<Keyspace: DBKeyspace>(
        &self,
        key: &Keyspace::Key,
    ) -> anyhow::Result<Option<Keyspace::Entry>> {
        let keyspace = self.get_keyspace(Keyspace::keyspace_id()).clone();
        let key = serde_json::to_vec(key)?;

        let data = tokio::task::spawn_blocking(move || keyspace.get(key)).await??;

        match data {
            Some(data) => {
                let entry = serde_json::from_slice(&data)?;
                Ok(Some(entry))
            }
            _ => Ok(None),
        }
    }

    pub async fn insert<Keyspace: DBKeyspace>(
        &self,
        key: &Keyspace::Key,
        entry: &Keyspace::Entry,
    ) -> anyhow::Result<()> {
        let keyspace = self.get_keyspace(Keyspace::keyspace_id()).clone();
        let key = serde_json::to_vec(key)?;
        let entry = serde_json::to_vec(entry)?;

        tokio::task::spawn_blocking(move || keyspace.insert(key, entry)).await??;

        Ok(())
    }

    pub async fn get_or_insert_default<Keyspace: DBKeyspace>(
        &self,
        key: &Keyspace::Key,
    ) -> anyhow::Result<Keyspace::Entry> {
        let keyspace = self.get_keyspace(Keyspace::keyspace_id()).clone();
        let key = serde_json::to_vec(key)?;

        tokio::task::spawn_blocking(move || match keyspace.get(&key)? {
            Some(entry) => {
                let entry = serde_json::from_slice(&entry)?;
                Ok(entry)
            }
            None => {
                let entry = Keyspace::Entry::default();
                keyspace.insert(key, serde_json::to_vec(&entry)?)?;
                Ok(entry)
            }
        })
        .await?
    }
}
