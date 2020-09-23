"use strict";
process.title 				= 'ascope-node-websocket';
process.env.TZ 				= 'Asia/Jakarta';
const WebSocket 			= require('ws');
const isValidUTF8 			= require('utf-8-validate');
const utf8 					= require('utf8');
const mysql 				= require('mysql2/promise');
const r 					= require('rethinkdb');
const logs4js 				= require('log4js');
const https 				= require('https');
const fs 					= require('fs');
const jwt 					= require('jsonwebtoken');

const webSocketsServerPort 	= 3000;
let httpsServer;
let wsServer;
let myconn;
let rethinkdbConn;

async function main(){

	try {
		myconn = await mysql.createConnection({
			host		: 'localhost',
			user		: 'adxscopeuser',
			password	: '&Dfhs509',
			database	: 'adxsco5_smartv'
		});
	}catch (e) {
		console.log('Mysql connect failed')
		console.log(e)
	}

	if (myconn) {
		console.log('Mysql connect success')
		try {
			rethinkdbConn = await r.connect({
				host: 'localhost',
				port: 32769,
				user:'adxscopeuser',
				password:'Dfhs509',
				db: 'adxsco5_smartv',
			});
		}catch (e) {
			console.log('Rethinkdb connect failed')
			console.log(e)
		}
	}

	// if (rethinkdbConn) {
	// 	const privateKey 	= fs.readFileSync('certs/key.pem', 'utf8');
	// 	const certificate 	= fs.readFileSync('certs/cert.pem', 'utf8');

	// 	const credentials = { key: privateKey, cert: certificate};

	// 	try {
	// 		httpsServer = https.createServer(credentials);
	// 		httpsServer.listen(webSocketsServerPort);	
	// 	} catch (error) {
	// 		console.log(error)
	// 	}
	// }

	if (rethinkdbConn) {
		console.log('Rethinkdb connect success')
		/**
		* WebSocket server
        */
		wsServer = new WebSocket.Server({
            // server: httpsServer,
            port: webSocketsServerPort,
			perMessageDeflate: {
				zlibDeflateOptions: {
					chunkSize: 1024,
					memLevel: 7,
					level: 3
				},
				zlibInflateOptions: {
					chunkSize: 10 * 1024
				},
				clientNoContextTakeover: true, 
				serverNoContextTakeover: true, 
				serverMaxWindowBits: 10,
				concurrencyLimit: 10, // Limits zlib concurrency for perf.
				threshold: 1024 // Size (in bytes) below which messages
			}
		});
		console.log("Websocket Running On Port: "+ webSocketsServerPort);

		// Rethinkdb Changefeed
		const listen = () => {
			r.table('asc_ooh_device')
			.changes({ includeInitial: true })
			.run(rethinkdbConn, function(err, cursor) {
				cursor.each(function (err, data){
					if (data.new_val.ownerid) {
						r.table('asc_ooh_device').filter({
							'ownerid': data.new_val.ownerid,
						}).run(rethinkdbConn)
						.then(function(cursor) {
							return cursor.toArray();
						})
						.then(function(result) {
							let json = JSON.stringify({ type:'userList', data: result });
							// Send Device State To Observer
							if (observer[data.new_val.ownerid]) {
								observer[data.new_val.ownerid].ws.send(json);
							}
						})
					}
				});
			})
		}

		listen();
	}

	const log4js  = logs4js.configure({
		appenders: {
			everything: { 
				type: 'dateFile', 
				filename: 'logs/websocket.log', 
				alwaysIncludePattern: true,
				pattern: "yyyy-MM-dd", 
				maxLogSize: 10485760, 
				backups: 3, 
				compress: true
			}
		},
		categories: {
		  default: { appenders: [ 'everything' ], level: 'info' }
		}
	});

	const logger = log4js.getLogger();

	const getDate = () => {
		let today 	= new Date();
		let dd 		= String(today.getDate()).padStart(2, '0');
		let mm 		= String(today.getMonth() + 1).padStart(2, '0'); //January is 0!
		let yyyy 	= today.getFullYear();
		let hours 	= today.getHours();
		let minutes = today.getMinutes();
		let seconds = today.getSeconds();

		today = hours + ':' + minutes + ':' + seconds + ' ' + dd + '/' + mm + '/' + yyyy;
		return today;
	}

	/**
	* Global variables
	*/
	var clients 	 	= {};
	var device 			= {};
	var observer 		= {};

	try {
        function noop() {}

        function heartbeat() {
            this.isAlive = true;
        }
        
		wsServer.on('connection', function connection(ws, req) {
            ws.isAlive = true;
            ws.on('pong', heartbeat);

			// Generate JWT Tokens
			// var token = jwt.sign({
			// 		data: 'foobar'
			// 	}, 'secret');
			// console.log(token);
	
			let id  				= req.headers['sec-websocket-key'];
			clients[id] 			= {};
			clients[id].ws 			= ws;
			clients[id].id 		 	= id;
			clients[id].isLogged 	= false;
	
			// For Observer
			if (req.url !== '/') {
				let id 					= req.url.substr(1);
				observer[id] 			= {};
				observer[id].ws 		= ws;
				observer[id].id 		= id;
			}
			// For Device
			else {
				device[id] 				= {};
				device[id].ws 			= ws;
				device[id].id 		 	= id;
			}
	
			const sentAuthRequest = async () => {
				let json 				= JSON.stringify({ type:'requestAuth', data: '' });
				const AuthRequest 		= await clients[id].ws.send(json);
			}
	
			// Sent Auth Request After client is connected
			sentAuthRequest();	
	
			ws.on('message', async function incoming(message) {
				// Convert to utf8 if incoming message is not utf8
				const buf = Buffer.from(message);
				if (isValidUTF8(buf)) {
					try {
						var json 		= JSON.parse(message);
						var typeCommand = json.type;
					} catch (e) {
						let msg =  JSON.stringify({ type:'error', data: 'Not Valid JSON' });
						clients[id].ws.send(msg);
					}
					
				}else {
					var dt 			= utf8.encode(message);
					var json 		= JSON.parse(dt);
					var typeCommand = json.type;
				}
	
				if (!clients[id].isLogged) {
					switch (typeCommand) {
						// Verify Client Authentication
						case 'auth':
							console.log((new Date()) + ' Client Token: '+ json.data);
							// Client Authentication For Device
							if (json.authFor == 'device') {
								try {
									let data  				= json.data;
									const [rows, fields] 	= await myconn.execute('SELECT aod.displayid, aod.name, aol.ownerid FROM asc_ooh_device aod JOIN asc_ooh_device_location_assoc aodla ON aod.displayid = aodla.device_id JOIN asc_ooh_location aol ON aodla.location_id = aol.locationid WHERE aod.uniqueid =?', [data]);
		
									if (rows.length > 0 ){
										// Client Identification
										clients[id].isLogged 	= true;
										clients[id].clientType 	= 'device';
	
										device[id].user 		= {};
										device[id].user 		= rows[0];
										device[id].name 		= rows[0].name;
										device[id].displayid 	= rows[0].displayid;
										device[id].ownerid 		= rows[0].ownerid;
	
										// Send Auth Success Response To Client
										const sentAuthResponse = async () => {
											let json 			= JSON.stringify({ type:'authResponse', data: 'Auth Sucess'});
											const authResponse 	= await device[id].ws.send(json);
											console.log((new Date()) + ' Connection accepted.');
										}
	
										sentAuthResponse();
		
										try {
											// Check Device Data On Rethinkdb
											r.table('asc_ooh_device')
											.filter({
												'displayid': device[id].displayid,
											})
											.run(rethinkdbConn)
											.then(function(cursor) {
												return cursor.toArray()
											})
											.then(function(results) {
												// Change State Device On Rethinkdb
												if (results != null && results != '') {
													r.table('asc_ooh_device')
													.get(results[0].id)
													.update(
														{status: 1, last_active: getDate()},
														{returnChanges: true})
													.run(rethinkdbConn)
													.then(function() {
                                                        ws.token = data;
                                                        ws.clientType = 'device';
                                                        ws.displayid = device[id].user.displayid;
                                                        ws.name = device[id].user.name;
														// console.log('Success update data')
													})
													.then(function() {
														logger.info(device[id].name + ' connected');
													})
													.error(function(err) {
														console.log(err)
													})
												}
												else {
													r.table('asc_ooh_device')
													.insert(
														{
															name 		: device[id].user.name,
															displayid 	: device[id].user.displayid,
															ownerid 	: device[id].user.ownerid,
                                                            status 		: 1,
                                                            last_active : getDate(),
														},
														{
															returnChanges: true
														})
													.run(rethinkdbConn)
													.then(function() {
                                                        ws.token = data;
                                                        ws.clientType = 'device';
                                                        ws.displayid = device[id].user.displayid;
                                                        ws.name = device[id].user.name;
														console.log('Success insert new data')
													})
													.then(function() {
														logger.info(device[id].name + ' connected');
													})
													.error(function(err) {
														console.log(err)
													})
												}
											}).catch(function(err) {
												console.log(err)
											})					
										} catch (error) {
											console.log(error);
										}
	
									}else{
										var json = JSON.stringify({ type:'authResponse', data: 'Auth Failed' });
										device[id].ws.send(json);
										device[id].ws.close();
									}
								} 
								catch(err) {
									var json = JSON.stringify({ type:'closeConnection', data: 'Not Valid Credential' });
		
									device[id].ws.send(json);
									device[id].ws.close();
									console.log(err);
									console.log((new Date()) + ' Connection Refused, Reason: '+ 'Not Valid Credential');
								}
							}
							// Client Authentication For Observer
							else if (json.authFor == 'observer') {
								try {
									// var decoded 			= jwt.verify(json.data, 'secret');
									let data  				= json.data;
									const [rows, fields] 	= await myconn.execute('SELECT * FROM asc_ooh_owners WHERE `ownerid` = ? ', [data]);
		
									if (rows.length > 0 ){
										// Client Identification
										clients[id].isLogged 	= true;
										clients[id].clientType 	= 'observer';
	
										// Send Auth Success Response To Client
										const sentAuthResponse = async () => {
											let json 			= JSON.stringify({ type:'authResponse', data: 'Auth Sucess'});
											const authResponse 	= await observer[data].ws.send(json);
											console.log((new Date()) + ' Connection accepted.');
										}
	
										sentAuthResponse();
	
										const getObsData = () => {
											r.table('asc_ooh_device')
											.filter({
												'ownerid': parseInt(data, 10),
											})
											.run(rethinkdbConn)
											.then(function(cursor) {
												return cursor.toArray();
											})
											.then(function(result) {
												let json = JSON.stringify({ type:'userList', data: result });
												// Send Device State To Observer
												if (observer[data]) {
													observer[data].ws.send(json);
												}
											})
										}
	
										getObsData()
	
									}else{
										var json = JSON.stringify({ type:'authResponse', data: 'Auth Failed' });
										clients[id].ws.send(json);
										clients[id].ws.close();
									}
								} 
								catch(err) {
									var json = JSON.stringify({ type:'closeConnection', data: 'Not Valid Credential' });
		
									clients[id].ws.send(json);
									clients[id].ws.close();
									console.log(err);
									console.log((new Date()) + ' Connection Refused, Reason: '+ 'Not Valid Credential');
								}
							}	
							break;
	
						default:
							let msg =  JSON.stringify({ type:'error', data: 'Not Valid Command' });
							clients[id].ws.send(msg);
					}
				}
	
				else if (clients[id].isLogged) {
					switch (typeCommand) {
						// Send Ping Response To Client
						case 'ping':
							try {
								// console.log();
								var pingData = 'ping from ' + device[id].name + ' ok';
								var json = JSON.stringify({ type:'pingResponse', data: pingData });
								if (observer[device[id].ownerid]) {
									observer[device[id].ownerid].ws.send(json);
								}
							} catch (error) {
								console.log(error);
							}
							
							break;
						// Send Video Duration Response To Client
						case 'sendVidDuration':
							try {
								// Check Device Data On Rethinkdb
								r.table('asc_ooh_data_playback')
								.filter({
									'displayid': device[id].displayid,
								})
								.run(rethinkdbConn)
								.then(function(cursor) {
									return cursor.toArray()
								})
								.then(function(results) {
									// Change State Device On Rethinkdb
									if (results != null && results != '') {
										r.table('asc_ooh_data_playback')
										.get(results[0].id)
										.update(
											{time : json.data, videoid : json.idVideo,},
											{returnChanges: true})
										.run(rethinkdbConn)
										.then(function() {
											// console.log('Success update data playback')
										})
										.then(function() {
											let vidDurationData = ' video current duration : ' + json.data;
											JSON.stringify({ type:'vidDurationResponse', data: vidDurationData });
										})
										.error(function(err) {
											console.log(err)
										})
									}
									else {
										r.table('asc_ooh_data_playback')
										.insert(
											{
												displayid 	: device[id].user.displayid,
												time 		: json.data,
												videoid 	: json.idVideo,
											},
											{
												returnChanges: true
											})
										.run(rethinkdbConn)
										.then(function() {
											console.log('Success insert new data playback')
										})
										.then(function() {
											let vidDurationData = ' video current duration : ' + json.data;
											JSON.stringify({ type:'vidDurationResponse', data: vidDurationData });
										})
										.error(function(err) {
											console.log(err)
										})
									}
								}).catch(function(err) {
									console.log(err)
								})					
							} catch (error) {
								console.log(error);
							}
							break;
						default:
							console.log((new Date()) + ' Undefined Type Command');
					}
				}
			});
	
			// user disconnected
			ws.on('close', async function close() {
	
				if (clients[id].clientType == 'device') {
					const closeDevice = () => {
						r.table('asc_ooh_device')
						.filter({
							'displayid': device[id].displayid,
						})
						.run(rethinkdbConn).then(function(cursor) {
							return cursor.toArray()
						})
						.then(function(results) {
							r.table('asc_ooh_device')
							.get(results[0].id)
							.update({status: 0, last_active: getDate(),}, {returnChanges: true})
							.run(rethinkdbConn)
							.then(function() {
								// console.log('Success update data')
							})
							.then(function() {
								logger.info(device[id].name + ' disconnected');
								delete clients[id];
								delete device[id];
							})
							.error(function(err) {
								console.log(err)
							})
						})
						.catch(function(err) {
							console.log(err)
						})
					}
	
					closeDevice();
				}
				else if (clients[id].clientType == 'observer') {
					delete clients[id];
					delete observer[id];
				}
			});
        });
        
        const interval = setInterval(function ping() {
            wsServer.clients.forEach(function each(ws) {
                if (ws.isAlive === false && ws.clientType === 'device') {
                    const closeDevice = () => {
						r.table('asc_ooh_device')
						.filter({
							'displayid': ws.displayid,
						})
						.run(rethinkdbConn).then(function(cursor) {
							return cursor.toArray()
						})
						.then(function(results) {
							r.table('asc_ooh_device')
							.get(results[0].id)
							.update({status: 0, last_active: getDate(),}, {returnChanges: true})
							.run(rethinkdbConn)
							.then(function() {
								// console.log('Success update data')
							})
							.then(function() {
								logger.info(ws.name + ' disconnected');
								delete clients[ws.id];
								delete device[ws.id];
							})
							.error(function(err) {
								console.log(err)
							})
						})
						.catch(function(err) {
							console.log(err)
						})
					}
	
					closeDevice();
                };
          
                ws.isAlive = false;
                ws.ping(noop);
            });
        }, 30000);

	} catch (error) {
		console.log(error)
	}
}

main();