use std::time::Duration;

use anyhow::anyhow;
use fjall::{Database, Keyspace, KeyspaceCreateOptions};
use futures_util::{SinkExt, StreamExt};
use json::JsonValue;
use serde::{Deserialize, Serialize};
use tokio::net::{TcpListener, TcpStream};
use tokio_websockets::{Message, ServerBuilder, WebSocketStream};
use uuid::{Uuid, fmt::Urn};

use crate::database::{
    DatabaseHandle, StratEntry, StratId, StratsKeyspace, Username, UsersKeyspace,
};

mod database;

pub struct MapMetadata {
    pub name: &'static str,
    pub floors: &'static [&'static str],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MapId {
    Chalet,
    Coastline,
}

impl MapId {
    pub fn all_maps() -> &'static [MapId] {
        use MapId::*;
        &[Chalet, Coastline]
    }

    pub fn from_map_name(s: &str) -> Option<Self> {
        for map in Self::all_maps() {
            if map.metadata().name == s {
                return Some(*map);
            }
        }

        None
    }

    pub fn metadata(&self) -> &'static MapMetadata {
        match self {
            MapId::Chalet => &MapMetadata {
                name: "chalet",
                floors: &["basement", "floor_1", "floor_2", "roof"],
            },
            MapId::Coastline => &MapMetadata {
                name: "coastline",
                floors: &["floor_1", "floor_2", "roof"],
            },
        }
    }
}

// #[derive(Deserialize, Serialize, Debug, PartialEq)]
// pub struct StratId(pub Uuid);

// #[derive(Deserialize, Serialize, Debug, PartialEq)]
// pub struct Map {
//     //
// }

// fn foo(map: Map) {
//     //
// }

// pub trait DBKeyspace {
//     type Key: Serialize + for<'a> Deserialize<'a>;
//     type Entry: Default + Serialize + for<'a> Deserialize<'a>;

//     fn keyspace_id() -> DBKeyspaceId;
// }

// pub struct UsersKeyspace;

// #[derive(Deserialize, Serialize, Debug, PartialEq)]
// pub struct Username(pub String);

// #[derive(Deserialize, Serialize, Debug, PartialEq)]
// pub struct UsersEntry {
//     pub strats: Vec<StratId>,
// }

// // pub struct Users

// // impl DBKeyspaceType for UsersKeyspace {
// //     type KeyType = Username;
// //     type EntryType = ;
// // }

// #[derive(Debug, Clone, Copy)]
// pub enum DBKeyspaceId {
//     /// "username" => { "strats": ["strat_uuid1", ...] }
//     Users,
//     /// "strat_uuid" => { "name": "?", "map": "?", "lines": [{ "from": [1, 2], "to": [3, 4] }, ...] }
//     Strategies,
// }

// #[derive(Clone)]
// pub struct DatabaseHandle {
//     #[allow(unused)]
//     database: Database,
//     users: Keyspace,
//     strategies: Keyspace,
// }

// impl DatabaseHandle {
//     fn get_keyspace(&self, keyspace: DBKeyspaceId) -> &Keyspace {
//         match keyspace {
//             DBKeyspaceId::Users => &self.users,
//             DBKeyspaceId::Strategies => &self.strategies,
//         }
//     }

//     pub async fn get(&self, keyspace: DBKeyspaceId, key: &str) -> Result<JsonValue, anyhow::Error> {
//         let keyspace = self.get_keyspace(keyspace).clone();
//         let key = key.to_string();

//         let data = tokio::task::spawn_blocking(move || {
//             Ok::<_, anyhow::Error>(
//                 keyspace
//                     .get(key)?
//                     .expect("Called `get_json` but the entry didn't exist")
//                     .to_vec(),
//             )
//         })
//         .await??;

//         Ok(json::parse(&String::from_utf8(data)?)?)
//     }

//     pub async fn get_or_insert(
//         &self,
//         keyspace: DBKeyspaceId,
//         key: &str,
//         default: impl FnOnce() -> JsonValue + Send + 'static,
//     ) -> Result<JsonValue, anyhow::Error> {
//         let ksp = self.get_keyspace(keyspace).clone();
//         let key_clone = key.to_string();
//         tokio::task::spawn_blocking(move || {
//             if !ksp.contains_key(&key_clone)? {
//                 let default = default();
//                 ksp.insert(key_clone, default.dump())?;
//             }
//             Ok::<_, anyhow::Error>(())
//         })
//         .await??;

//         self.get(keyspace, key).await
//     }

//     pub async fn insert(
//         &self,
//         keyspace: DBKeyspaceId,
//         key: String,
//         value: JsonValue,
//     ) -> Result<(), anyhow::Error> {
//         let keyspace = self.get_keyspace(keyspace).clone();
//         tokio::task::spawn_blocking(move || keyspace.insert(key, value.dump())).await??;

//         Ok(())
//     }
// }

pub struct ReceivedMsg {
    length: usize,
    message_type: String,
    msg: JsonValue,
}

trait WsStreamExt {
    async fn send_json(&mut self, msg: JsonValue) -> Result<(), tokio_websockets::Error>;

    async fn next_json(&mut self) -> Result<ReceivedMsg, anyhow::Error>;
}

impl WsStreamExt for WebSocketStream<TcpStream> {
    async fn send_json(&mut self, msg: JsonValue) -> Result<(), tokio_websockets::Error> {
        self.send(Message::text(msg.dump())).await
    }

    async fn next_json(&mut self) -> Result<ReceivedMsg, anyhow::Error> {
        let msg = self
            .next()
            .await
            .ok_or(anyhow!("Websocket closed down!"))??;
        let msg_len = msg.as_payload().len();
        let msg = json::parse(
            msg.as_text()
                .ok_or(anyhow!("Received message that wasn't JSON"))?,
        )?;

        if !msg.has_key("message_type") || !msg["message_type"].is_string() {
            return Err(anyhow!(
                "Received message without a `message_type: string` field!"
            ));
        }

        Ok(ReceivedMsg {
            length: msg_len,
            message_type: msg["message_type"].as_str().unwrap().to_string(),
            msg,
        })
    }
}

async fn accept_client(
    mut ws_stream: WebSocketStream<TcpStream>,
    database: DatabaseHandle,
) -> Result<(), anyhow::Error> {
    // Handshake
    let user = {
        // ---STEP 1: Client says "hello"
        let ReceivedMsg {
            length: _,
            message_type,
            msg: _,
        } = ws_stream.next_json().await?;
        if message_type != "hello" {
            return Err(anyhow!(
                "Expected a `hello` message, received `{message_type}`"
            ));
        }

        // ---STEP 2: Server says "hello_response"
        ws_stream
            .send_json(json::object! { message_type: "hello_response" })
            .await?;

        // ---STEP 3: Client sends a login request
        let ReceivedMsg {
            length: _,
            message_type,
            msg,
        } = ws_stream.next_json().await?;
        if message_type != "login_request" {
            return Err(anyhow!(
                "Expected a `login_request` message, received `{message_type}`"
            ));
        }

        let user = msg["username"].as_str().unwrap();
        let user = Username(user.to_string());

        database
            .get_or_insert_default::<UsersKeyspace>(&user)
            .await?;

        // ---STEP 4: Server tells the client that the login was successful
        ws_stream
            .send_json(json::object! { message_type: "login_response" })
            .await?;

        user
    };

    println!("[{user}] Client finished login");

    // Loop
    while let Ok(ReceivedMsg {
        length: message_length,
        message_type,
        msg,
    }) = ws_stream.next_json().await
    {
        println!(
            "[{user}] received message ({}): {}",
            bytesize::ByteSize::b(message_length as u64),
            {
                let mut msg_str = format!("{msg}");
                msg_str.truncate(msg_str.floor_char_boundary(100));
                msg_str
            },
        );
        match message_type.as_str() {
            "get_strat_list" => {
                let Some(user_info) = database.get::<UsersKeyspace>(&user).await? else {
                    continue;
                };

                let mut strats_response: Vec<JsonValue> = vec![];

                for strat_id in &user_info.strats {
                    let strat_info = database.get::<StratsKeyspace>(strat_id).await?.unwrap();

                    strats_response.push(
                        json::object! { strat_id: strat_id.to_string(), strat_name: strat_info.name, map: strat_info.map },
                    );
                }

                ws_stream
                    .send_json(
                        json::object! { message_type: "get_strat_list_response", strats: strats_response },
                    )
                    .await?;
            }
            "create_empty_strat" => {
                let strat_id = StratId::new();

                let mut user_info = database.get::<UsersKeyspace>(&user).await?.unwrap();
                user_info.strats.push(strat_id.clone());
                database.insert::<UsersKeyspace>(&user, &user_info).await?;

                let map = msg["map"].as_str().unwrap();

                database
                    .insert::<StratsKeyspace>(
                        &strat_id,
                        &StratEntry {
                            name: "unnamed".into(),
                            map: map.into(),
                            paths: vec![],
                        },
                    )
                    .await?;

                ws_stream
                    .send_json(json::object! { message_type: "create_empty_strat_response", strat_id: strat_id.to_string() })
                    .await?;
            }
            "get_map_metadata" => {
                let map_name = msg["map"].as_str().unwrap();
                let map_id = MapId::from_map_name(map_name).unwrap();
                let MapMetadata { name: _, floors } = *map_id.metadata();

                ws_stream
                    .send_json(
                        json::object! { message_type: "get_map_metadata_response", floors: floors },
                    )
                    .await?;
            }
            "save_strat" => {
                let strat_id = msg["strat_id"].as_str().unwrap();
                let strat_id = StratId(Uuid::try_parse(strat_id)?);
                let free_draw_paths = msg["free_draw_paths"]
                    .members()
                    .map(|path| path)
                    .collect::<Vec<_>>();

                let Some(mut strat) = database.get::<StratsKeyspace>(&strat_id).await? else {
                    continue;
                };
                // Update strat entry...
                // ...
                database.insert::<StratsKeyspace>(&strat_id, &strat).await?;
            }
            mty => println!("Unexpected message_type: `{mty}`",),
        }
    }

    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), anyhow::Error> {
    let listener = TcpListener::bind("127.0.0.1:8080").await?;
    let database = DatabaseHandle::initialize().await?;

    println!("Started!");

    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let (_request, ws_stream) = ServerBuilder::new().accept(stream).await?;

            println!("Client Accepted at {:?}", ws_stream.get_ref().local_addr());

            let db_clone = database.clone();
            tokio::spawn(async move { accept_client(ws_stream, db_clone).await });
        }

        Ok::<_, anyhow::Error>(())
    })
    .await
    .unwrap()?;

    Ok(())
}
