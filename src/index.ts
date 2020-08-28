import Koa from 'koa';
import route from 'koa-route';
import websockify from 'koa-websocket';
import morgan from 'koa-morgan';
import bodyParser from 'koa-bodyparser';
import json from 'koa-json';
import cors from '@koa/cors';

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

class Channels {
  private readonly channels = new Map<ChannelId, Channel>();
  private nextChannelId = 1;

  create({ name }: { readonly name: string }): Channel {
    this.validateChannelName(name);
    const channel: Channel = {
      id: this.issueNextChannelId(),
      name,
      messages: [],
    };
    this.channels.set(channel.id, channel);
    return channel;
  }

  changeName({ id, name }: { readonly id: number; name: string }): Channel {
    const channel = this.channels.get(id);
    if (!channel) {
      throw new Error('チャネルが存在しません。');
    }
    this.validateChannelName(name);
    const newChannel = { ...channel, name };
    this.channels.set(id, newChannel);
    return newChannel;
  }

  getChannel(id: number): Channel | undefined {
    return this.channels.get(id);
  }

  getAllChannels(): Channel[] {
    return [...this.channels.values()];
  }

  deleteChannel(id: number): void {
    this.channels.delete(id);
  }

  private validateChannelName(name: string): void {
    if (name.length === 0) {
      throw new Error('チャネル名は1文字以上にしてください。');
    }
    if (name.length > 15) {
      throw new Error('チャネル名は15文字以内にしてください。');
    }
    if (!/^[A-Za-z0-9_-]*$/.test(name)) {
      throw new Error('チャネル名は半角英数にしてください。');
    }
    if (
      Array.from(this.channels.values()).some(channel => channel.name === name)
    ) {
      throw new Error('すでに存在しているチャネル名は使用できません。');
    }
  }

  private issueNextChannelId(): ChannelId {
    return this.nextChannelId++;
  }
}

const channels = new Channels();
channels.create({ name: 'general' });
channels.create({ name: 'random' });

const app = websockify(new Koa());
app.use(cors());
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
    try {
      ctx.body = channels.create({ name });
    } catch (e) {
      ctx.throw(400, e.message);
    }
  }),
);

// チャンネル一覧
app.use(
  route.get('/channels', ctx => {
    ctx.body = channels.getAllChannels();
  }),
);

// チャンネル設定変更
app.use(
  route.patch('/channels/:id', (ctx, idString: string) => {
    const id = Number(idString);
    const channel = channels.getChannel(id);
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
    try {
      ctx.body = channels.changeName({ id, name: newName });
    } catch (e) {
      ctx.throw(400, e.message);
    }
  }),
);

// チャンネル削除
app.use(
  route.delete('/channels/:id', (ctx, idString: string) => {
    const id = Number(idString);
    const channel = channels.getChannel(id);
    if (!channel) {
      ctx.throw(404, 'Channel not found');
      return;
    }
    channels.deleteChannel(id);
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
      const channel = channels.getChannel(data.channelId);
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

app.listen(3001);

function assertChannelName(name: unknown): asserts name is string {
  if (typeof name === 'undefined') {
    throw new Error('name parameter is missing');
  }
  if (typeof name !== 'string') {
    throw new Error('name parameter is not a string value');
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
