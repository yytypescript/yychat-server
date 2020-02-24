import Koa from 'koa';
import route from 'koa-route';
import websockify from 'koa-websocket';
import morgan from 'koa-morgan';
import bodyParser from 'koa-bodyparser';
import json from 'koa-json';

type ChannelId = number;

interface Channel {
  readonly id: ChannelId;
  readonly name: string;
  readonly messages: Message[];
}

interface Message {
  readonly userName: string;
  readonly text: string;
}

let nextChannelId = 1;

function issueNextChannelId(): ChannelId {
  return nextChannelId++;
}

const channels = new Map<ChannelId, Channel>();
const general = { id: issueNextChannelId(), name: 'general', messages: [] };
const random = { id: issueNextChannelId(), name: 'random', messages: [] };
channels.set(general.id, general);
channels.set(random.id, random);

const app = websockify(new Koa());
app.use(morgan('dev'));
app.use(bodyParser());
app.use(json());

// エラー処理
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    ctx.status = err.status || 500;
    ctx.body = err;
    ctx.app.emit('error', err, ctx);
  }
});

// チャンネル新規作成
app.use(
  route.post('/channels', ctx => {
    const name: unknown = ctx.request.body.name;
    try {
      assertChannelName(name);
    } catch (e) {
      ctx.throw(400, e.message);
      return;
    }
    const channel = { id: issueNextChannelId(), name, messages: [] };
    channels.set(channel.id, channel);
    ctx.body = channel;
  }),
);

// チャンネル一覧
app.use(
  route.get('/channels', ctx => {
    ctx.body = [...channels.values()];
  }),
);

// チャンネル設定変更
app.use(
  route.patch('/channels/:id', (ctx, id: string) => {
    const channel = channels.get(Number(id));
    if (!channel) {
      ctx.throw(404, 'Channel not found');
      return;
    }
    const newName: unknown = ctx.request.body.name;
    try {
      assertChannelName(newName);
    } catch (e) {
      ctx.throw(400, e.message);
      return;
    }
    channels.set(channel.id, { ...channel, name: newName });
    ctx.body = '';
  }),
);

// チャンネル削除
app.use(
  route.delete('/channels/:id', (ctx, id: string) => {
    const channel = channels.get(Number(id));
    if (!channel) {
      ctx.throw(404, 'Channel not found');
      return;
    }
    channels.delete(Number(id));
    ctx.body = '';
  }),
);

// メッセージAPI
app.ws.use(
  route.all('/messages', ctx => {
    ctx.websocket.on('message', (rawData: string) => {
      console.log('received: %o', rawData);
      let data: unknown;
      try {
        data = JSON.parse(rawData);
      } catch (e) {
        ctx.websocket.send(
          JSON.stringify({ type: 'error', message: e.message }),
        );
        return;
      }
      if (!isNewMessage(data)) {
        ctx.websocket.send(
          JSON.stringify({ type: 'error', message: 'Invalid message format' }),
        );
        return;
      }
      if (data.userName.length < 1) {
        ctx.websocket.send(
          JSON.stringify({
            type: 'error',
            message: 'Message userName must be longer than 0 character',
          }),
        );
        return;
      }
      if (data.text.length < 1) {
        ctx.websocket.send(
          JSON.stringify({
            type: 'error',
            message: 'Message text must be longer than 0 character',
          }),
        );
        return;
      }
      const channel = channels.get(data.channelId);
      if (!channel) {
        ctx.websocket.send(
          JSON.stringify({
            type: 'error',
            message: 'Channel not found',
          }),
        );
        return;
      }
      channel.messages.push({ userName: data.userName, text: data.text });
      // broadcast message
      app.ws.server?.clients.forEach(client =>
        client.send(JSON.stringify(data)),
      );
    });
  }),
);

app.listen(3000);

function assertChannelName(name: unknown): asserts name is string {
  if (typeof name === 'undefined') {
    throw new Error('name parameter is missing');
  }
  if (typeof name !== 'string') {
    throw new Error('name parameter is not a string value');
  }
  if (name.length === 0) {
    throw new Error('チャンネル名を入力してください。');
  }
}

function isNewMessage(value: unknown): value is NewMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as NewMessageLike).type === 'message' &&
    typeof (value as NewMessageLike).channelId === 'number' &&
    typeof (value as NewMessageLike).userName === 'string' &&
    typeof (value as NewMessageLike).text === 'string'
  );
}

interface NewMessage {
  readonly type: 'message';
  readonly channelId: ChannelId;
  readonly userName: string;
  readonly text: string;
}

type NewMessageLike = Partial<Record<keyof NewMessage, unknown>>;
