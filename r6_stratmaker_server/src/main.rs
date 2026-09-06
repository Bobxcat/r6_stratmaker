use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_websockets::{Message, ServerBuilder};

#[tokio::main]
async fn main() -> Result<(), tokio_websockets::Error> {
    let listener = TcpListener::bind("127.0.0.1:8080").await?;

    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let (_request, mut ws_stream) = ServerBuilder::new().accept(stream).await?;

            println!("Client Accepted at {:?}", ws_stream.get_ref().local_addr());

            tokio::spawn(async move {
                while let Some(Ok(msg)) = ws_stream.next().await {
                    if msg.is_text() {
                        let msg = json::parse(msg.as_text().unwrap()).unwrap();
                        match msg["message_type"].as_str().unwrap() {
                            "hello" => {
                                ws_stream
                                    .send(Message::text(
                                        json::object! {
                                            message_type: "hello_response",
                                        }
                                        .dump(),
                                    ))
                                    .await?;

                                // let response = json::object! {
                                //     message_type: "set_active_map",
                                //     map_name: "chalet",
                                //     floors: ["basement", "floor_1", "floor_2", "roof"],
                                // };
                                // ws_stream.send(Message::text(response.dump())).await?
                            }
                            mty => println!("Unexpected message_type: `{mty}`",),
                        }
                    }
                }

                Ok::<_, tokio_websockets::Error>(())
            });
            //
        }

        Ok::<_, tokio_websockets::Error>(())
    })
    .await
    .unwrap()?;

    Ok(())
}
