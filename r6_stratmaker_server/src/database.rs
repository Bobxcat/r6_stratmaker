use std::fmt::Display;

use anyhow::Error;
use fjall::{Database, Keyspace, KeyspaceCreateOptions};
use json::JsonValue;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub trait DBKeyspace {
    type Key: Serialize + for<'a> Deserialize<'a> + Send;
    type Entry: Default + Serialize + for<'a> Deserialize<'a> + Send + 'static;

    fn keyspace_id() -> DBKeyspaceId;
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
pub struct StratPlacedIcon {
    pub img: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Deserialize, Serialize, Default, Debug)]
pub struct StratPhaseFloor {
    pub draw_paths: Vec<Vec<[f64; 2]>>,
    pub placed_icons: Vec<StratPlacedIcon>,
}

#[derive(Deserialize, Serialize, Default, Debug)]
pub struct StratPhase {
    pub phase_name: String,
    pub floors: Vec<StratPhaseFloor>,
}

#[derive(Deserialize, Serialize, Default, Debug)]
pub struct StratEntry {
    pub strat_name: String,
    pub map: String,
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

    // async fn _get(&self, keyspace: DBKeyspaceId, key: &str) -> anyhow::Result<JsonValue> {
    //     let keyspace = self.get_keyspace(keyspace).clone();
    //     let key = key.to_string();

    //     let data = tokio::task::spawn_blocking(move || {
    //         Ok::<_, anyhow::Error>(
    //             keyspace
    //                 .get(key)?
    //                 .expect("Called `get_json` but the entry didn't exist")
    //                 .to_vec(),
    //         )
    //     })
    //     .await??;

    //     Ok(json::parse(&String::from_utf8(data)?)?)
    // }

    // async fn _get_or_insert(
    //     &self,
    //     keyspace: DBKeyspaceId,
    //     key: &str,
    //     default: impl FnOnce() -> JsonValue + Send + 'static,
    // ) -> anyhow::Result<JsonValue> {
    //     let ksp = self.get_keyspace(keyspace).clone();
    //     let key_clone = key.to_string();
    //     tokio::task::spawn_blocking(move || {
    //         if !ksp.contains_key(&key_clone)? {
    //             let default = default();
    //             ksp.insert(key_clone, default.dump())?;
    //         }
    //         Ok::<_, anyhow::Error>(())
    //     })
    //     .await??;

    //     self.get(keyspace, key).await
    // }

    // pub async fn _insert(
    //     &self,
    //     keyspace: DBKeyspaceId,
    //     key: String,
    //     value: JsonValue,
    // ) -> anyhow::Result<()> {
    //     let keyspace = self.get_keyspace(keyspace).clone();
    //     tokio::task::spawn_blocking(move || keyspace.insert(key, value.dump())).await??;

    //     Ok(())
    // }
}
