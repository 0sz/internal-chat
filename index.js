const WebSocket = require('ws');
const service = require('./data');
const path = require('path');

const http = require('http');
const fs = require('fs');

const originalLog = console.log;
console.log = function() {
  const date = new Date();
  const pad = (num) => String(num).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  
  const timestamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${ms}`;
  
  originalLog.apply(console, [`[${timestamp}]`, ...arguments]);
};
const HTTP_PORT = process.argv[2] || 8281; // 合并后的统一端口
const HTTP_DIRECTORY = path.join(__dirname, 'www'); // 静态文件目录

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]); // 去掉查询参数
  if (urlPath === '/') {
    urlPath = '/index.html'; // 默认访问 index.html
  }
  let filePath = path.join(HTTP_DIRECTORY, urlPath);
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // 如果文件不存在，返回 index.html
      filePath = path.join(HTTP_DIRECTORY, 'index.html');
    }

    // 设置缓存头
    const ext = path.extname(filePath);
    if (ext === '.js' || ext === '.css') {
      res.setHeader('Cache-Control', 'public, max-age=2592000'); // 30天缓存
    }

    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(HTTP_PORT, () => {
  console.log(`server start on port ${HTTP_PORT}`);
});


const wsServer = new WebSocket.Server({ server });


const SEND_TYPE_REG = '1001'; // 注册后发送用户id
const SEND_TYPE_ROOM_INFO = '1002'; // 发送房间信息
const SEND_TYPE_JOINED_ROOM = '1003'; // 加入房间后的通知，比如对于新进用户，Ta需要开始连接其他人
const SEND_TYPE_NEW_CANDIDATE = '1004'; // offer
const SEND_TYPE_NEW_CONNECTION = '1005'; // new connection
const SEND_TYPE_CONNECTED = '1006'; // new connection
const SEND_TYPE_NICKNAME_UPDATED = '1007'; // 昵称更新通知

const RECEIVE_TYPE_NEW_CANDIDATE = '9001'; // offer
const RECEIVE_TYPE_NEW_CONNECTION = '9002'; // new connection
const RECEIVE_TYPE_CONNECTED = '9003'; // joined
const RECEIVE_TYPE_KEEPALIVE = '9999'; // keep-alive
const RECEIVE_TYPE_UPDATE_NICKNAME = '9004'; // 更新昵称请求

// 从room_pwd.json中获取房间密码
let roomPwd = { };
try {
  // 获取可执行程序所在目录
  const exePath = process.pkg ? path.dirname(process.execPath) : __dirname;
  roomPwdConfig = require(path.join(exePath, 'room_pwd.json'));
  let roomIds = [];
  roomPwdConfig.forEach(item => {
    roomIds.push(item.roomId);
    roomPwd[item.roomId] = { "pwd": item.pwd, "turns": item.turns };
  });
  console.log(`加载房间数据: ${roomIds.join(',')}`);
} catch (e) {
  // 没有room_pwd.json文件无需报错，不加载即可
  // console.error('Failed to load room_pwd.json');
}

wsServer.on('connection', (socket, request) => {
  const ip = request.headers['x-forwarded-for'] ?? request.headers['x-real-ip'] ?? socket._socket.remoteAddress.split("::ffff:").join("");
  const urlWithPath = request.url.replace(/^\//g, '').split('/')
  let roomId = null;
  let pwd = null;
  if (urlWithPath.length > 1 && urlWithPath[1].length > 0 && urlWithPath[1].length <= 32) {
    roomId = urlWithPath[1].trim();
  }
  if (urlWithPath.length > 2 && urlWithPath[2].length > 0 && urlWithPath[2].length <= 32) {
    pwd = urlWithPath[2].trim();
  }
  if (roomId === 'ws') {  // 兼容旧版本
    roomId = null;
  }
  if (roomId === '') {
    roomId = null;
  }
  let turns = null;
  if (roomId) {
    if (!pwd || !roomPwd[roomId] || roomPwd[roomId].pwd.toLowerCase() !== pwd.toLowerCase()) {
      roomId = null;
    } else {
      turns = roomPwd[roomId].turns;
    }
  }
  const currentId = service.registerUser(ip, roomId, socket);
  // 向客户端发送自己的id
  socketSend_UserId(socket, currentId, roomId, turns);
  
  console.log(`${currentId}@${ip}${roomId ? '/' + roomId : ''} connected`);
  
  service.getUserList(ip, roomId).forEach(user => {
    socketSend_RoomInfo(user.socket, ip, roomId);
  });

  socketSend_JoinedRoom(socket, currentId);
  

  socket.on('message', (msg, isBinary) => {
    const msgStr = msg.toString();
    if (!msgStr || msgStr.length > 1024 * 10) {
      return;
    }
    let message = null;
    try {
      message = JSON.parse(msgStr);
    } catch (e) {
      console.error('Invalid JSON', msgStr);
      message = null;
    }

    const { uid, targetId, type, data } = message;
    if (!type || !uid || !targetId) {
      return null;
    }
    const me = service.getUser(ip, roomId, uid)
    const target = service.getUser(ip, roomId, targetId)
    if (!me || !target) {
      return;
    }

    if (type === RECEIVE_TYPE_NEW_CANDIDATE) {
      socketSend_Candidate(target.socket, { targetId: uid, candidate: data.candidate });
      return;
    }
    if (type === RECEIVE_TYPE_NEW_CONNECTION) {
      socketSend_ConnectInvite(target.socket, { targetId: uid, offer: data.targetAddr });
      return;
    }
    if (type === RECEIVE_TYPE_CONNECTED) {
      socketSend_Connected(target.socket, { targetId: uid, answer: data.targetAddr });
      return;
    }
    if (type === RECEIVE_TYPE_KEEPALIVE) {
      return;
    }
    if (type === RECEIVE_TYPE_UPDATE_NICKNAME) {
      const success = service.updateNickname(ip, roomId, uid, data.nickname);
      if (success) {
        // 通知所有用户昵称更新
        service.getUserList(ip, roomId).forEach(user => {
          socketSend_NicknameUpdated(user.socket, { id: uid, nickname: data.nickname });
        });
      }
      return;
    }
    
  });

  socket.on('close', () => {
    service.unregisterUser(ip, roomId, currentId);
    service.getUserList(ip, roomId).forEach(user => {
      socketSend_RoomInfo(user.socket, ip, roomId);
    });
    console.log(`${currentId}@${ip}${roomId ? '/' + roomId : ''} disconnected`);
  });

  socket.on('error', () => {
    service.unregisterUser(ip, roomId, currentId);
    service.getUserList(ip, roomId).forEach(user => {
      socketSend_RoomInfo(user.socket, ip, roomId);
    });
    console.log(`${currentId}@${ip}${roomId ? '/' + roomId : ''} disconnected`);
  });
});




function send(socket, type, data) {
  socket.send(JSON.stringify({ type, data }));
}

function socketSend_UserId(socket, id, roomId, turns) {
  send(socket, SEND_TYPE_REG, { id, roomId, turns });
}
function socketSend_RoomInfo(socket, ip, roomId) {
  const result = service.getUserList(ip, roomId).map(user => ({ 
    id: user.id,
    nickname: user.nickname 
  }));
  send(socket, SEND_TYPE_ROOM_INFO, result);
}
function socketSend_JoinedRoom(socket, id) {
  send(socket, SEND_TYPE_JOINED_ROOM, { id });
}

function socketSend_Candidate(socket, data) {
  send(socket, SEND_TYPE_NEW_CANDIDATE, data);
}

function socketSend_ConnectInvite(socket, data) {
  send(socket, SEND_TYPE_NEW_CONNECTION, data);
}

function socketSend_Connected(socket, data) {
  send(socket, SEND_TYPE_CONNECTED, data);
}

function socketSend_NicknameUpdated(socket, data) {
  send(socket, SEND_TYPE_NICKNAME_UPDATED, data);
}
