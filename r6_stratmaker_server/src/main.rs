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
                            "get_img" => {
                                let response = json::object! {
                                    message_type: "get_img_response",
                                    map_name: "chalet",
                                    img_path: "/maps/chalet/basement.jpg",
                                };
                                ws_stream.send(Message::text(response.dump())).await?
                            }
                            _ => (),
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
