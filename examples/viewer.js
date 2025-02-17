/**
 * This file demonstrates the process of starting WebRTC streaming using a KVS Signaling Channel.
 */
const viewer = {};
function getTIme(){
    var now = new Date();
    var target = document.getElementById("DateTimeDisp");

    var Year = now.getFullYear();
    var Month = now.getMonth()+1;
    var DATE = now.getDate();
    var Hour = now.getHours();
    var Min = now.getMinutes();
    var Sec = now.getSeconds();

    var datestring = Year +"/"  + Month + "/" + DATE + ":" + Hour + ":" + Min + ":" + Sec;

    return datestring
}

async function startViewer(localView, remoteView, formValues, onStatsReport, onRemoteDataMessage) {
    try {
        viewer.localView = localView;
        viewer.remoteView = remoteView;

        // Create KVS client
        const kinesisVideoClient = new AWS.KinesisVideo({
            region: formValues.region,
            accessKeyId: formValues.accessKeyId,
            secretAccessKey: formValues.secretAccessKey,
            sessionToken: formValues.sessionToken,
            endpoint: formValues.endpoint,
            correctClockSkew: true,
        });

        // Get signaling channel ARN
        const describeSignalingChannelResponse = await kinesisVideoClient
            .describeSignalingChannel({
                ChannelName: formValues.channelName,
            })
            .promise();
        const channelARN = describeSignalingChannelResponse.ChannelInfo.ChannelARN;
        console.log('[VIEWER] Channel ARN:', channelARN);

        // Get signaling channel endpoints
        const getSignalingChannelEndpointResponse = await kinesisVideoClient
            .getSignalingChannelEndpoint({
                ChannelARN: channelARN,
                SingleMasterChannelEndpointConfiguration: {
                    Protocols: ['WSS', 'HTTPS'],
                    Role: KVSWebRTC.Role.VIEWER,
                },
            })
            .promise();
        const endpointsByProtocol = getSignalingChannelEndpointResponse.ResourceEndpointList.reduce((endpoints, endpoint) => {
            endpoints[endpoint.Protocol] = endpoint.ResourceEndpoint;
            return endpoints;
        }, {});
        console.log('[VIEWER] Endpoints:', endpointsByProtocol);

        const kinesisVideoSignalingChannelsClient = new AWS.KinesisVideoSignalingChannels({
            region: formValues.region,
            accessKeyId: formValues.accessKeyId,
            secretAccessKey: formValues.secretAccessKey,
            sessionToken: formValues.sessionToken,
            endpoint: endpointsByProtocol.HTTPS,
            correctClockSkew: true,
        });

        // Get ICE server configuration
        const getIceServerConfigResponse = await kinesisVideoSignalingChannelsClient
            .getIceServerConfig({
                ChannelARN: channelARN,
            })
            .promise();
        const iceServers = [];
        if (!formValues.natTraversalDisabled && !formValues.forceTURN) {
            iceServers.push({ urls: `stun:stun.kinesisvideo.${formValues.region}.amazonaws.com:443` });
        }
        if (!formValues.natTraversalDisabled) {
            getIceServerConfigResponse.IceServerList.forEach(iceServer =>
                iceServers.push({
                    urls: iceServer.Uris,
                    username: iceServer.Username,
                    credential: iceServer.Password,
                }),
            );
        }
        console.log('[VIEWER] ICE servers:', iceServers);

        // Create Signaling Client
        viewer.signalingClient = new KVSWebRTC.SignalingClient({
            channelARN,
            channelEndpoint: endpointsByProtocol.WSS,
            clientId: formValues.clientId,
            role: KVSWebRTC.Role.VIEWER,
            region: formValues.region,
            credentials: {
                accessKeyId: formValues.accessKeyId,
                secretAccessKey: formValues.secretAccessKey,
                sessionToken: formValues.sessionToken,
            },
            systemClockOffset: kinesisVideoClient.config.systemClockOffset,
        });

        const resolution = formValues.widescreen
            ? {
                  width: { ideal: 1280 },
                  height: { ideal: 720 },
              }
            : { width: { ideal: 640 }, height: { ideal: 480 } };
        const constraints = {
            video: formValues.sendVideo ? resolution : false,
            audio: formValues.sendAudio,
        };
        const configuration = {
            iceServers,
            iceTransportPolicy: formValues.forceTURN ? 'relay' : 'all',
        };
        viewer.peerConnection = new RTCPeerConnection(configuration);
        //if (formValues.openDataChannel) {
        viewer.dataChannel = viewer.peerConnection.createDataChannel('kvsDataChannel');
        viewer.peerConnection.ondatachannel = event => {
            event.channel.onmessage = onRemoteDataMessage;
        };
//        }

        // Poll for connection stats
        viewer.peerConnectionStatsInterval = setInterval(() => viewer.peerConnection.getStats().then(onStatsReport), 1000);

        viewer.signalingClient.on('open', async () => {
            console.log('[VIEWER] Connected to signaling service');

            // Get a stream from the webcam, add it to the peer connection, and display it in the local view.
            // If no video/audio needed, no need to request for the sources.
            // Otherwise, the browser will throw an error saying that either video or audio has to be enabled.
            if (formValues.sendVideo || formValues.sendAudio) {
                try {
                    viewer.localStream = await navigator.mediaDevices.getUserMedia(constraints);
                    viewer.localStream.getTracks().forEach(track => viewer.peerConnection.addTrack(track, viewer.localStream));
                    localView.srcObject = viewer.localStream;
                } catch (e) {
                    console.error('[VIEWER] Could not find webcam');
                    return;
                }
            }

            // Create an SDP offer to send to the master
            console.log('[VIEWER] Creating SDP offer');
            await viewer.peerConnection.setLocalDescription(
                await viewer.peerConnection.createOffer({
                    offerToReceiveAudio: true,
                    offerToReceiveVideo: true,
                }),
            );

            // When trickle ICE is enabled, send the offer now and then send ICE candidates as they are generated. Otherwise wait on the ICE candidates.
            if (formValues.useTrickleICE) {
                console.log('[VIEWER] Sending SDP offer');
                viewer.signalingClient.sendSdpOffer(viewer.peerConnection.localDescription);
            }
            console.log('[VIEWER] Generating ICE candidates');
        });

        viewer.signalingClient.on('sdpAnswer', async answer => {
            // Add the SDP answer to the peer connection
            console.log('[VIEWER] Received SDP answer');
            await viewer.peerConnection.setRemoteDescription(answer);
        });

        viewer.signalingClient.on('iceCandidate', candidate => {
            // Add the ICE candidate received from the MASTER to the peer connection
            console.log('[VIEWER] Received ICE candidate');
            viewer.peerConnection.addIceCandidate(candidate);
        });

        viewer.signalingClient.on('close', () => {
            console.log('[VIEWER] Disconnected from signaling channel');
        });

        viewer.signalingClient.on('error', error => {
            console.error('[VIEWER] Signaling client error:', error);
        });

        // Send any ICE candidates to the other peer
        viewer.peerConnection.addEventListener('icecandidate', ({ candidate }) => {
            if (candidate) {
                console.log('[VIEWER] Generated ICE candidate');

                // When trickle ICE is enabled, send the ICE candidates as they are generated.
                if (formValues.useTrickleICE) {
                    console.log('[VIEWER] Sending ICE candidate');
                    viewer.signalingClient.sendIceCandidate(candidate);
                }
            } else {
                console.log('[VIEWER] All ICE candidates have been generated');

                // When trickle ICE is disabled, send the offer now that all the ICE candidates have ben generated.
                if (!formValues.useTrickleICE) {
                    console.log('[VIEWER] Sending SDP offer');
                    viewer.signalingClient.sendSdpOffer(viewer.peerConnection.localDescription);
                }
            }
        });

        // As remote tracks are received, add them to the remote view
        viewer.peerConnection.addEventListener('track', event => {
            console.log('[VIEWER] Received remote track');
            if (remoteView.srcObject) {
                return;
            }
            viewer.remoteStream = event.streams[0];
            remoteView.srcObject = viewer.remoteStream;
        });

        console.log('[VIEWER] Starting viewer connection');
        viewer.signalingClient.open();
    } catch (e) {
        console.error('[VIEWER] Encountered error starting:', e);
    }

    var bytes_sent = 0 ;
    var bytes_received = 0;
    // Display Bitrate
    setInterval( () => {
        viewer.peerConnection.getStats(null).then(async (stats) => {
            let statsOutput = "";
            let speedOutputIn = "<h4> Inbound </h4> <br> \n";
            let speedOutputOut = "<h4> Outbound </h4> <br> \n";
            let logspeedin = ""
            let constraintsOutput = "<h3> Constraints </h3> <br> \n";
            let bitrate_out = 0;
            let bitrate_in = 0;
            stats.forEach((report) => {
                statsOutput +=
                    `<h4>Report: ${report.type}</h4>\n<strong>ID:</strong> ${report.id}<br>\n` +
                    `<strong>Timestamp:</strong> ${report.timestamp}<br>\n`;

                // Now the statistics for this report; we intentionally drop the ones we
                // sorted to the top above

                Object.keys(report).forEach((statName) => {
                    if (
                        statName !== "id" &&
                            statName !== "timestamp" &&
                            statName !== "type"
                    ) {
                        statsOutput += `<strong>${statName}:</strong> ${report[statName]}<br>\n`;
                    }
                });

                if (report.type == "inbound-rtp") {
                    bitrate_in = (report["bytesReceived"] - bytes_received )*8.0/3.0/1000;
                    bytes_received = report["bytesReceived"];
                    speedOutputIn += `<strong>timestamp:</strong> ${report.timestamp}<br>\n`;
                    speedOutputIn += `<strong>bitrate:</strong> ${bitrate_in}[kbps]<br>\n`;
                    speedOutputIn += `<strong>bytesReceived:</strong> ${bytes_received}[bytes]<br>\n`;
                    speedOutputIn += `<strong>width:</strong> ${report["frameWidth"]}<br>\n`;
                    speedOutputIn += `<strong>height:</strong> ${report["frameHeight"]}<br>\n`;
                    speedOutputIn += `<strong>fps:</strong> ${report["framesPerSecond"]}<br>\n`;
                    datestring = getTIme();
                    logspeedin +=  `${datestring},  ${bitrate_in},  ${bytes_received}, ${report["frameWidth"]}, ${report["frameHeight"]}\n`
                }
                else if (report.type == "outbound-rtp") {
                    bitrate_out = (report["bytesSent"] - bytes_sent )*8.0/3.0/1000;
                    bytes_sent = report["bytesSent"];
                    speedOutputOut += `<strong>timestamp:</strong> ${report.timestamp}<br>\n`;
                    speedOutputOut += `<strong>bitrate:</strong> ${bitrate_out}[kbps]<br>\n`;
                    speedOutputOut += `<strong>bytesReceived:</strong> ${bytes_sent}[bytes]<br>\n`;
                    speedOutputOut += `<strong>width:</strong> ${report["frameWidth"]}<br>\n`;
                    speedOutputOut += `<strong>height:</strong> ${report["frameHeight"]}<br>\n`;
                    speedOutputOut += `<strong>fps:</strong> ${report["framesPerSecond"]}<br>\n`;                }
            });

            document.querySelector(".Stats-Inbound").innerHTML = speedOutputIn;
            document.querySelector(".Stats-Outbound").innerHTML = speedOutputOut;
            $('#speed_log').append(logspeedin);
        });

    } , 3000);
    $('#test-button').click(async () => {
        let videoTrack = viewer.remoteStream.getVideoTracks()[0];
        let currentConstraints = videoTrack.getConstraints();
        let w = 640;
        let h = 360;
        if (constraints.video.width.ideal == 640) {
            w = 1280;
            h = 720;
        }
        videoTrack.applyConstraints({
            width: {ideal: w},
            height: {ideal: h},
            frameRate: {ideal: 30}
        }).then(() => {
            currentConstraints = videoTrack.getConstraints();
            console.log("(w,h) :(", w, ",",h, ') 変更後の値:', currentConstraints);
            constraints.video = currentConstraints;

        }).catch(e => {
            console.log('制約を設定できませんでした:', e);
        });
    });

}

function stopViewer() {
    try {
        console.log('[VIEWER] Stopping viewer connection');
        if (viewer.signalingClient) {
            viewer.signalingClient.close();
            viewer.signalingClient = null;
        }

        if (viewer.peerConnection) {
            viewer.peerConnection.close();
            viewer.peerConnection = null;
        }

        if (viewer.localStream) {
            viewer.localStream.getTracks().forEach(track => track.stop());
            viewer.localStream = null;
        }

        if (viewer.remoteStream) {
            viewer.remoteStream.getTracks().forEach(track => track.stop());
            viewer.remoteStream = null;
        }

        if (viewer.peerConnectionStatsInterval) {
            clearInterval(viewer.peerConnectionStatsInterval);
            viewer.peerConnectionStatsInterval = null;
        }

        if (viewer.localView) {
            viewer.localView.srcObject = null;
        }

        if (viewer.remoteView) {
            viewer.remoteView.srcObject = null;
        }

        if (viewer.dataChannel) {
            viewer.dataChannel = null;
        }
    } catch (e) {
        console.error('[VIEWER] Encountered error stopping', e);
    }
}

$('#resize-button').click(async () => {

    const width = $('#video-width-input').val();
    const height = $('#video-height-input').val();
    const bitrate = $('#video-bitrate-input').val();
    const message =  `${width}, ${height}, ${bitrate}\n`;

    if (viewer.dataChannel) {
        try {
            viewer.dataChannel.send(message);
        } catch (e) {
            console.error('[VIEWER] Send DataChannel:', e.toString());
        }
    }
});


function sendViewerMessage(message) {
    if (viewer.dataChannel) {
        try {
            viewer.dataChannel.send(message);
        } catch (e) {
            console.error('[VIEWER] Send DataChannel:', e.toString());
        }
    }
}
