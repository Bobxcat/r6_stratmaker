use std::time::Duration;

use anyhow::anyhow;
use fjall::{Database, Keyspace, KeyspaceCreateOptions};
use futures_util::{SinkExt, StreamExt};
use json::JsonValue;
use tokio::net::{TcpListener, TcpStream};
use tokio_websockets::{Message, ServerBuilder, WebSocketStream};
use uuid::Uuid;

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

#[derive(Debug, Clone, Copy)]
pub enum DBKeyspace {
    /// "username" => { "strats": ["strat_uuid1", ...] }
    Users,
    /// "strat_uuid" => { "name": "?", "map": "?", "lines": [{ "from": [1, 2], "to": [3, 4] }, ...] }
    Strategies,
}

#[derive(Clone)]
pub struct DatabaseHandle {
    #[allow(unused)]
    database: Database,
    users: Keyspace,
    strategies: Keyspace,
}

impl DatabaseHandle {
    pub fn get_keyspace(&self, keyspace: DBKeyspace) -> &Keyspace {
        match keyspace {
            DBKeyspace::Users => &self.users,
            DBKeyspace::Strategies => &self.strategies,
        }
    }

    pub async fn get(&self, keyspace: DBKeyspace, key: &str) -> Result<JsonValue, anyhow::Error> {
        let keyspace = self.get_keyspace(keyspace).clone();
        let key = key.to_string();

        let data = tokio::task::spawn_blocking(move || {
            Ok::<_, anyhow::Error>(
                keyspace
                    .get(key)?
                    .expect("Called `get_json` but the entry didn't exist")
                    .to_vec(),
            )
        })
        .await??;

        Ok(json::parse(&String::from_utf8(data)?)?)
    }

    pub async fn get_or_insert(
        &self,
        keyspace: DBKeyspace,
        key: &str,
        default: impl FnOnce() -> JsonValue + Send + 'static,
    ) -> Result<JsonValue, anyhow::Error> {
        let ksp = self.get_keyspace(keyspace).clone();
        let key_clone = key.to_string();
        tokio::task::spawn_blocking(move || {
            if !ksp.contains_key(&key_clone)? {
                let default = default();
                ksp.insert(key_clone, default.dump())?;
            }
            Ok::<_, anyhow::Error>(())
        })
        .await??;

        self.get(keyspace, key).await
    }

    pub async fn insert(
        &self,
        keyspace: DBKeyspace,
        key: String,
        value: JsonValue,
    ) -> Result<(), anyhow::Error> {
        let keyspace = self.get_keyspace(keyspace).clone();
        tokio::task::spawn_blocking(move || keyspace.insert(key, value.dump())).await??;

        Ok(())
    }
}

pub struct ReceivedMsg {
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
        let ReceivedMsg { message_type, msg } = ws_stream.next_json().await?;
        if message_type != "login_request" {
            return Err(anyhow!(
                "Expected a `login_request` message, received `{message_type}`"
            ));
        }

        let user = msg["username"].as_str().unwrap();

        database
            .get_or_insert(DBKeyspace::Users, user, || {
                json::object! { strats: [] }
            })
            .await?;

        // ---STEP 4: Server tells the client that the login was successful
        ws_stream
            .send_json(json::object! { message_type: "login_response" })
            .await?;

        user.to_string()
    };

    println!("Client finished login");

    // Loop
    while let Ok(ReceivedMsg { message_type, msg }) = ws_stream.next_json().await {
        match message_type.as_str() {
            "hello" => {
                ws_stream
                    .send(Message::text(
                        json::object! {
                            message_type: "hello_response",
                        }
                        .dump(),
                    ))
                    .await?;

                tokio::time::sleep(Duration::from_millis(1000)).await;

                ws_stream
                    .send(Message::text(
                        json::object! {
                            message_type: "freedraw_line",
                            from_x: 10,
                            from_y: 10,
                            to_x: 100,
                            to_y: 100,
                        }
                        .dump(),
                    ))
                    .await
                    .unwrap();

                let response = json::object! {
                    message_type: "set_active_map",
                    map_name: "chalet",
                    floors: ["basement", "floor_1", "floor_2", "roof"],
                };
                ws_stream.send(Message::text(response.dump())).await?
            }
            "get_strat_list" => {
                let user_info = database.get(DBKeyspace::Users, &user).await?;

                let mut strats: Vec<JsonValue> = vec![];

                for strat_id in user_info["strats"].members() {
                    let strat_id = strat_id.as_str().unwrap();
                    let strat_info = database.get(DBKeyspace::Strategies, strat_id).await?;

                    let strat_name = strat_info["name"].as_str().unwrap();
                    let map = strat_info["map"].as_str().unwrap();

                    strats.push(
                        json::object! { strat_id: strat_id, strat_name: strat_name, map: map },
                    );
                }

                ws_stream
                    .send_json(
                        json::object! { message_type: "get_strat_list_response", strats: strats },
                    )
                    .await?;
            }
            "create_empty_strat" => {
                let strat_id = format!("{}", Uuid::new_v4());

                let mut user_info = database.get(DBKeyspace::Users, &user).await?;
                user_info["strats"].push(strat_id.clone())?;
                database
                    .insert(DBKeyspace::Users, user.clone(), user_info)
                    .await?;

                let map = msg["map"].as_str().unwrap();

                database
                    .insert(
                        DBKeyspace::Strategies,
                        strat_id.clone(),
                        json::object! { name: "unnamed", map: map, lines: [] },
                    )
                    .await?;

                ws_stream
                    .send_json(json::object! { message_type: "create_empty_strat_response", strat_id: strat_id })
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
            mty => println!("Unexpected message_type: `{mty}`",),
        }
    }

    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), anyhow::Error> {
    let database = Database::builder(".fjall_database").open()?;
    let database = DatabaseHandle {
        users: database.keyspace("users", KeyspaceCreateOptions::default)?,
        strategies: database.keyspace("strategies", KeyspaceCreateOptions::default)?,
        database,
    };

    let listener = TcpListener::bind("127.0.0.1:8080").await?;

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
