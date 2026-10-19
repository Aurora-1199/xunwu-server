const express = require("express");
const cookieParser = require("cookie-parser");
const { rateLimit } = require("express-rate-limit");

const { DatabaseSync } = require("node:sqlite");
const { mkdirSync } = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const sharp = require("sharp");

const {
  randomBytes,
  pbkdf2,
  timingSafeEqual,
  createHash
} = require("node:crypto");

const deriveKey = promisify(pbkdf2);

const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

const BASE_URL = new URL(
  process.env.PUBLIC_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://127.0.0.1:${PORT}`
).origin;

// 只有部署到 Render 时，才启用这项代理配置。
if (process.env.RENDER === "true") {
  app.set("trust proxy", 1);
}

const COOKIE_NAME = "xunwu_session";
const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000;

// 当前代码用于本机 HTTP 开发。
const cookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: BASE_URL.startsWith("https://"),
  path: "/"
};

// 一、准备数据库文件夹和数据库。
const dataDirectory =
  process.env.DATA_DIR || path.join(__dirname, "data");
mkdirSync(dataDirectory, { recursive: true });

const db = new DatabaseSync(
  path.join(dataDirectory, "xunwu.db")
);

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// 创建物品表，已有数据库也可以直接增加这张表。
db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    user_id INTEGER NOT NULL,

    kind TEXT NOT NULL
      CHECK (kind IN ('lost', 'found')),

    name TEXT NOT NULL,
    place TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',

    status TEXT NOT NULL DEFAULT 'open'
      CHECK (status IN ('open', 'resolved')),

    created_at TEXT NOT NULL
      DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    FOREIGN KEY (user_id)
      REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_items_user
  ON items(user_id);
`);

// 给已有物品表增加照片字段。
// 如果已经存在，就不重复添加。
const itemColumns = db.prepare("PRAGMA table_info(items)").all();

if (!itemColumns.some(function (column) {
  return column.name === "photo";
})) {
  db.exec("ALTER TABLE items ADD COLUMN photo BLOB");
}

// ↓ 从这里开始，添加这次的新代码
const itemExtraColumns = db
  .prepare("PRAGMA table_info(items)")
  .all();

if (!itemExtraColumns.some(column => column.name === "category")) {
  db.exec(`
    ALTER TABLE items
    ADD COLUMN category TEXT NOT NULL DEFAULT 'uncategorized'
  `);
}

if (!itemExtraColumns.some(column => column.name === "event_at")) {
  db.exec(`
    ALTER TABLE items
    ADD COLUMN event_at TEXT
  `);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS item_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,

    kind TEXT NOT NULL
      CHECK (kind IN ('claim', 'clue')),

    content TEXT NOT NULL,

    created_at TEXT NOT NULL
      DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    FOREIGN KEY (item_id)
      REFERENCES items(id) ON DELETE CASCADE,

    FOREIGN KEY (user_id)
      REFERENCES users(id) ON DELETE CASCADE,

    UNIQUE (item_id, user_id, content)
  );
`);

// 给认领和线索记录增加“发布者已读时间”。
const responseColumns = db.prepare(
  "PRAGMA table_info(item_responses)"
).all();

if (!responseColumns.some(function (column) {
  return column.name === "owner_read_at";
})) {
  db.exec(
    "ALTER TABLE item_responses ADD COLUMN owner_read_at TEXT"
  );
}

// 二、基础设置。
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

app.use("/api", function (req, res, next) {
  res.set("Cache-Control", "no-store");

  // 测试页面与接口由同一个后端提供。
  const allowedOrigins = [
    BASE_URL,
    `http://localhost:${PORT}`
  ];

  const origin = req.get("origin");

  if (origin && !allowedOrigins.includes(origin)) {
    return res.status(403).json({
      message: "请从后端提供的测试页面访问接口。"
    });
  }

  next();
});

// 对注册和登录请求进行频率限制。
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "操作过于频繁，请稍后再试。"
  }
});

// 三、辅助函数。
function readCredentials(body) {
  if (
    !body ||
    typeof body.username !== "string" ||
    typeof body.password !== "string"
  ) {
    return null;
  }

  const username = body.username.trim().toLowerCase();
  const password = body.password;

  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    return null;
  }

  if (password.length < 8 || password.length > 64) {
    return null;
  }

  return { username, password };
}

// 保存密码摘要，不保存原始密码。
async function hashPassword(password, salt) {
  return deriveKey(
    password,
    salt,
    600000,
    32,
    "sha256"
  );
}

// 登录凭证在数据库中也只保存摘要。
function hashToken(token) {
  return createHash("sha256")
    .update(token)
    .digest("hex");
}

function getSessionHash(req) {
  const token = req.cookies[COOKIE_NAME];

  if (
    typeof token !== "string" ||
    !/^[a-f0-9]{64}$/.test(token)
  ) {
    return null;
  }

  return hashToken(token);
}

function getCurrentUser(req) {
  const tokenHash = getSessionHash(req);

  if (!tokenHash) {
    return null;
  }

  const user = db.prepare(`
    SELECT users.id, users.username
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
      AND sessions.expires_at > ?
  `).get(tokenHash, Date.now());

  return user || null;
}

// 四、检查后端是否运行。
app.get("/api/health", function (req, res) {
  res.json({
    ok: true,
    message: "寻物有声后端已启动"
  });
});

// 五、注册。
app.post("/api/auth/register", authLimiter, async function (req, res) {
  const credentials = readCredentials(req.body);

  if (!credentials) {
    return res.status(400).json({
      message:
        "用户名需要 3—20 位字母、数字或下划线；密码需要 8—64 位。"
    });
  }

  const salt = randomBytes(16).toString("hex");

  const passwordHash = await hashPassword(
    credentials.password,
    salt
  );

  // 保存新账号，同名注册不会覆盖已有账号。
  const result = db.prepare(`
    INSERT INTO users (
      username,
      password_hash,
      salt
    )
    VALUES (?, ?, ?)
    ON CONFLICT(username) DO NOTHING
  `).run(
    credentials.username,
    passwordHash.toString("hex"),
    salt
  );

  if (Number(result.changes) === 0) {
    return res.status(409).json({
      message: "这个用户名已经被注册。"
    });
  }

  res.status(201).json({
    message: "注册成功，请登录。",
    user: {
      id: Number(result.lastInsertRowid),
      username: credentials.username
    }
  });
});


// 六、登录。
app.post("/api/auth/login", authLimiter, async function (req, res) {
  const credentials = readCredentials(req.body);

  if (!credentials) {
    return res.status(400).json({
      message: "请检查用户名和密码格式。"
    });
  }

  const account = db.prepare(`
    SELECT id, username, password_hash, salt
    FROM users
    WHERE username = ?
  `).get(credentials.username);

  // 不存在的账号也执行一次密码计算。
  const salt = account ? account.salt : "0".repeat(32);
  const actualHash = await hashPassword(
    credentials.password,
    salt
  );

  if (
    !account ||
    !timingSafeEqual(
      actualHash,
      Buffer.from(account.password_hash, "hex")
    )
  ) {
    return res.status(401).json({
      message: "用户名或密码不正确。"
    });
  }

  // 清理过期登录记录。
  db.prepare(`
    DELETE FROM sessions WHERE expires_at <= ?
  `).run(Date.now());

  // 替换当前浏览器原来的登录凭证。
  const previousHash = getSessionHash(req);

  if (previousHash) {
    db.prepare(`
      DELETE FROM sessions WHERE token_hash = ?
    `).run(previousHash);
  }

  const token = randomBytes(32).toString("hex");

  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(
    hashToken(token),
    account.id,
    Date.now() + SESSION_DURATION
  );

  res.cookie(COOKIE_NAME, token, {
    ...cookieOptions,
    maxAge: SESSION_DURATION
  });

  res.json({
    message: "登录成功。",
    user: {
      id: account.id,
      username: account.username
    }
  });
});

// 七、查询当前登录账号。
app.get("/api/auth/me", function (req, res) {
  const user = getCurrentUser(req);

  if (!user) {
    return res.status(401).json({
      message: "当前未登录。"
    });
  }

  res.json({ user });
});

// 八、退出登录。
app.post("/api/auth/logout", function (req, res) {
  const tokenHash = getSessionHash(req);

  if (tokenHash) {
    db.prepare(`
      DELETE FROM sessions WHERE token_hash = ?
    `).run(tokenHash);
  }

  res.clearCookie(COOKIE_NAME, cookieOptions);

  res.json({
    message: "已退出登录。"
  });
});

// ===== 物品发布与查询 =====

// 需要登录才能继续的操作，统一使用这个函数检查。
function requireLogin(req, res, next) {
  const user = getCurrentUser(req);

  if (!user) {
    return res.status(401).json({
      message: "请先登录。"
    });
  }

  req.currentUser = user;
  next();
}

// 列表和详情统一返回这些字段。
// 不会返回用户的密码摘要等信息。
const itemSelect = `
  SELECT
    items.id,
    items.user_id AS ownerId,
    users.username AS owner,
    items.kind,
    items.name,
    items.place,
    items.description,
    items.category,
    items.event_at AS eventAt,
    items.status,
    items.created_at AS createdAt,
    CASE
      WHEN items.photo IS NOT NULL
      THEN '/api/items/' || items.id || '/photo'
      ELSE NULL
    END AS photo
  FROM items
  JOIN users ON users.id = items.user_id
`;

// 发布物品：必须登录。
app.post("/api/items", requireLogin, async function (req, res) {
  const body = req.body || {};

  // 一、检查文字字段。
  if (
    typeof body.name !== "string" ||
    typeof body.place !== "string" ||
    !["lost", "found"].includes(body.kind) ||
    (
      body.description !== undefined &&
      typeof body.description !== "string"
    )
  ) {
    return res.status(400).json({
      message: "请提供正确的名称、地点和物品类型。"
    });
  }

  const name = body.name.trim();
  const place = body.place.trim();
  const description = (body.description || "").trim();

  if (
    name.length < 1 ||
    name.length > 30 ||
    place.length < 1 ||
    place.length > 50 ||
    description.length > 120
  ) {
    return res.status(400).json({
      message:
        "名称需为 1—30 字，地点需为 1—50 字，描述最多 120 字。"
    });
  }
  const allowedCategories = [
  "card",
  "electronics",
  "daily",
  "study",
  "clothing",
  "other",
  "uncategorized"
];

// 兼容之前未提交类别的页面。
const category =
  body.category === undefined
    ? "uncategorized"
    : body.category;

if (!allowedCategories.includes(category)) {
  return res.status(400).json({
    message: "请选择有效的物品类别。"
  });
}

let eventAt = null;

if (
  body.eventAt !== undefined &&
  body.eventAt !== null &&
  body.eventAt !== ""
) {
  if (typeof body.eventAt !== "string") {
    return res.status(400).json({
      message: "时间格式不正确。"
    });
  }

  const eventDate = new Date(body.eventAt);

  if (
    !Number.isFinite(eventDate.getTime()) ||
    eventDate.toISOString() !== body.eventAt ||
    eventDate.getTime() > Date.now()
  ) {
    return res.status(400).json({
      message: "遗失或拾获时间无效，不能晚于当前时间。"
    });
  }

  eventAt = eventDate.toISOString();
}

  // 二、照片可选。没有照片时保存 null。
  let photoBuffer = null;
  if (
    body.photo !== undefined &&
    body.photo !== null &&
    body.photo !== ""
  ) {
    // 前端裁剪工具输出 JPEG 格式。
    const prefix = "data:image/jpeg;base64,";

    if (
      typeof body.photo !== "string" ||
      !body.photo.startsWith(prefix)
    ) {
      return res.status(400).json({
        message: "请先在页面中完成照片裁剪。"
      });
    }

    const encoded = body.photo.slice(prefix.length);

    if (encoded.length > 1400000) {
      return res.status(413).json({
        message: "裁剪后的照片过大，请更换照片后重试。"
      });
    }

    if (
      !encoded ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    ) {
      return res.status(400).json({
        message: "照片编码不正确，请重新选择并裁剪。"
      });
    }

    const inputBuffer = Buffer.from(encoded, "base64");

    if (inputBuffer.toString("base64") !== encoded) {
      return res.status(400).json({
        message: "照片数据不完整，请重新裁剪。"
      });
    }

    if (inputBuffer.length > 1024 * 1024) {
      return res.status(413).json({
        message: "裁剪后的照片不能超过 1MB。"
      });
    }

    // 检查 JPEG 文件头，再交给图片工具实际解码。
    if (
      inputBuffer[0] !== 0xff ||
      inputBuffer[1] !== 0xd8 ||
      inputBuffer[2] !== 0xff
    ) {
      return res.status(400).json({
        message: "照片格式不正确，请重新选择并裁剪。"
      });
    }

    try {
      photoBuffer = await sharp(inputBuffer, {
        limitInputPixels: 4000000,
        failOn: "warning"
      })
        .resize({
          width: 800,
          height: 600,
          fit: "inside",
          withoutEnlargement: true
        })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch (error) {
      return res.status(400).json({
        message: "无法处理这张照片，请更换后重试。"
      });
    }
  }

  // 三、文字和照片一起写入数据库。
  const result = db.prepare(`
  INSERT INTO items (
    user_id,
    kind,
    name,
    place,
    description,
    category,
    event_at,
    status,
    photo
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
`).run(
  req.currentUser.id,
  body.kind,
  name,
  place,
  description,
  category,
  eventAt,
  photoBuffer
);

  const item = db.prepare(
    itemSelect + " WHERE items.id = ?"
  ).get(Number(result.lastInsertRowid));

  res.status(201).json({
    message: "发布成功，已保存到数据库。",
    item: item
  });
});

// 查询列表的公共处理函数。
// ownerId 有值时，只查询这个用户发布的记录。
function sendItemList(req, res, ownerId = null) {
  const keyword = req.query.q ?? "";
  const kind = req.query.kind ?? "all";
  const pageText = req.query.page ?? "1";

  if (
    typeof keyword !== "string" ||
    keyword.length > 100 ||
    typeof kind !== "string" ||
    !["all", "lost", "found"].includes(kind) ||
    typeof pageText !== "string" ||
    !/^[1-9]\d{0,5}$/.test(pageText)
  ) {
    return res.status(400).json({
      message:
        "查询参数不正确。kind 可选 all、lost、found；page 为正整数。"
    });
  }

  const page = Number(pageText);
  const pageSize = 20;
  const offset = (page - 1) * pageSize;

  const conditions = ["1 = 1"];
  const values = [];

  if (ownerId !== null) {
    conditions.push("items.user_id = ?");
    values.push(ownerId);
  }

  if (kind !== "all") {
    conditions.push("items.kind = ?");
    values.push(kind);
  }

  const searchText = keyword.trim();

  if (searchText) {
    conditions.push(`
      (
        instr(lower(items.name), lower(?)) > 0
        OR instr(lower(items.place), lower(?)) > 0
      )
    `);

    values.push(searchText, searchText);
  }

  const where = " WHERE " + conditions.join(" AND ");

  const countResult = db.prepare(
    "SELECT COUNT(*) AS total FROM items" + where
  ).get(...values);

  const items = db.prepare(
    itemSelect +
    where +
    `
      ORDER BY
        CASE WHEN items.status = 'resolved' THEN 1 ELSE 0 END,
        items.created_at DESC,
        items.id DESC
      LIMIT ? OFFSET ?
    `
  ).all(...values, pageSize, offset);

  res.json({
    items: items,
    total: countResult.total,
    page: page,
    pageSize: pageSize
  });
}

// 我的发布：后端根据登录身份筛选。
app.get("/api/items/mine", requireLogin, function (req, res) {
  sendItemList(req, res, req.currentUser.id);
});

// 全部物品：未登录也能查看。
app.get("/api/items", function (req, res) {
  sendItemList(req, res);
});

// 查询物品，并检查是否属于当前登录用户。
function findOwnedItem(req, res) {
  const idText = req.params.id;
  const id = Number(idText);

  if (!/^[1-9]\d*$/.test(idText) || !Number.isSafeInteger(id)) {
    res.status(400).json({ message: "物品编号不正确。" });
    return null;
  }

  const item = db.prepare(
    itemSelect + " WHERE items.id = ?"
  ).get(id);

  if (!item) {
    res.status(404).json({ message: "这条信息不存在或已删除。" });
    return null;
  }

  if (item.ownerId !== req.currentUser.id) {
    res.status(403).json({ message: "只能管理自己发布的信息。" });
    return null;
  }

  return item;
}

// 修改完成状态。
app.patch("/api/items/:id/status", requireLogin, function (req, res) {
  const status = req.body?.status;

  if (!["open", "resolved"].includes(status)) {
    return res.status(400).json({
      message: "状态只能是 open 或 resolved。"
    });
  }

  const item = findOwnedItem(req, res);

  if (!item) {
    return;
  }

  db.prepare(`
    UPDATE items
    SET status = ?
    WHERE id = ? AND user_id = ?
  `).run(status, item.id, req.currentUser.id);

  res.json({
    message: "状态已保存。",
    item: db.prepare(
      itemSelect + " WHERE items.id = ?"
    ).get(item.id)
  });
});

// 删除自己的发布。
app.delete("/api/items/:id", requireLogin, function (req, res) {
  const item = findOwnedItem(req, res);

  if (!item) {
    return;
  }

  db.prepare(`
    DELETE FROM items
    WHERE id = ? AND user_id = ?
  `).run(item.id, req.currentUser.id);

  res.json({
    message: "已删除这条信息。"
  });
});

// 读取物品照片。
// 物品列表可以公开浏览，对应照片也可以公开浏览。
app.get("/api/items/:id/photo", function (req, res) {
  const idText = req.params.id;
  const id = Number(idText);

  if (!/^[1-9]\d*$/.test(idText) || !Number.isSafeInteger(id)) {
    return res.status(400).json({
      message: "物品编号不正确。"
    });
  }

  const row = db.prepare(`
    SELECT photo
    FROM items
    WHERE id = ?
  `).get(id);

  if (!row || row.photo === null) {
    return res.status(404).json({
      message: "这张照片不存在。"
    });
  }

  res.set("X-Content-Type-Options", "nosniff");
  res.type("image/jpeg");
  res.send(Buffer.from(row.photo));
});

// 查找对应物品，不要求查询者是发布者。
function findResponseItem(req, res) {
  const id = Number(req.params.id);

  if (
    !/^[1-9]\d*$/.test(req.params.id) ||
    !Number.isSafeInteger(id)
  ) {
    res.status(400).json({
      message: "物品编号不正确。"
    });
    return null;
  }

  const item = db.prepare(`
    SELECT id, user_id AS ownerId, kind, status
    FROM items
    WHERE id = ?
  `).get(id);

  if (!item) {
    res.status(404).json({
      message: "物品不存在或已删除。"
    });
    return null;
  }

  return item;
}

const responseSelect = `
  SELECT
    item_responses.id,
    item_responses.item_id AS itemId,
    item_responses.user_id AS authorId,
    users.username AS author,
    item_responses.kind,
    item_responses.content,
    item_responses.created_at AS createdAt

  FROM item_responses
  JOIN users ON users.id = item_responses.user_id
`;

// 查询记录：
// 发布者查看收到的全部记录。
// 其他登录用户只能查看自己提交的记录。
app.get("/api/items/:id/responses", requireLogin, function (req, res) {
  const item = findResponseItem(req, res);

  if (!item) {
    return;
  }

  const isOwner = item.ownerId === req.currentUser.id;

  const conditions = isOwner
    ? " WHERE item_responses.item_id = ?"
    : " WHERE item_responses.item_id = ? AND item_responses.user_id = ?";

  const values = isOwner
    ? [item.id]
    : [item.id, req.currentUser.id];

  const records = db.prepare(
    responseSelect +
    conditions +
    " ORDER BY item_responses.created_at DESC, item_responses.id DESC"
  ).all(...values);

  res.json({
    item: item,
    scope: isOwner ? "received" : "mine",
    records: records
  });
});

// 提交认领说明或物品线索。
app.post("/api/items/:id/responses", requireLogin, function (req, res) {
  const item = findResponseItem(req, res);

  if (!item) {
    return;
  }

  if (item.ownerId === req.currentUser.id) {
    return res.status(403).json({
      message: "不能向自己的物品提交认领或线索。"
    });
  }

  if (item.status !== "open") {
    return res.status(409).json({
      message: "这条信息已结束，不能新增提交。"
    });
  }

  const content = typeof req.body?.content === "string"
    ? req.body.content.trim()
    : "";

  if (content.length < 6 || content.length > 300) {
    return res.status(400).json({
      message: "请填写 6—300 字的有效内容。"
    });
  }

  // 类型由后端根据物品决定，不相信网页传来的类型。
  const kind = item.kind === "found" ? "claim" : "clue";

  const result = db.prepare(`
    INSERT INTO item_responses (
      item_id, user_id, kind, content
    )
    VALUES (?, ?, ?, ?)

    ON CONFLICT(item_id, user_id, content) DO NOTHING
  `).run(
    item.id,
    req.currentUser.id,
    kind,
    content
  );

  if (Number(result.changes) === 0) {
    return res.status(409).json({
      message: "相同内容已经提交，请查看已有记录。"
    });
  }

  const record = db.prepare(
    responseSelect + " WHERE item_responses.id = ?"
  ).get(Number(result.lastInsertRowid));

  res.status(201).json({
    message: "提交已保存，物品发布者可以在详情页查看。",
    record: record
  });
});

// 查询当前账号作为物品发布者收到的消息。
app.get("/api/notifications", requireLogin, function (req, res) {
  const userId = req.currentUser.id;

  const unread = db.prepare(`
    SELECT COUNT(*) AS total
    FROM item_responses AS r
    JOIN items ON items.id = r.item_id
    WHERE items.user_id = ?
      AND r.owner_read_at IS NULL
  `).get(userId);

  const rows = db.prepare(`
    SELECT
      r.id,
      r.kind,
      r.content,
      r.created_at AS createdAt,
      r.owner_read_at AS readAt,
      users.username AS author,

      items.id AS itemId,
      items.user_id AS ownerId,
      items.kind AS itemKind,
      items.name,
      items.place,
      items.description,
      items.category,
      items.event_at AS eventAt,
      items.status,

      CASE
        WHEN items.photo IS NOT NULL
        THEN '/api/items/' || items.id || '/photo'
        ELSE NULL
      END AS photo

    FROM item_responses AS r
    JOIN items ON items.id = r.item_id
    JOIN users ON users.id = r.user_id

    WHERE items.user_id = ?

    ORDER BY
      (r.owner_read_at IS NULL) DESC,
      r.created_at DESC,
      r.id DESC

    LIMIT 50
  `).all(userId);

  const notifications = rows.map(function (row) {
    return {
      id: row.id,
      kind: row.kind,
      content: row.content,
      author: row.author,
      createdAt: row.createdAt,
      readAt: row.readAt,

      item: {
        id: row.itemId,
        ownerId: row.ownerId,
        kind: row.itemKind,
        name: row.name,
        place: row.place,
        description: row.description,
        category: row.category,
        eventAt: row.eventAt,
        status: row.status,
        photo: row.photo
      }
    };
  });

  res.json({
    unreadCount: unread.total,
    notifications: notifications
  });
});

// 标记已读：只有对应物品的发布者能操作。
app.patch("/api/notifications/:id/read", requireLogin, function (req, res) {
  const idText = req.params.id;
  const id = Number(idText);

  if (!/^[1-9]\d*$/.test(idText) || !Number.isSafeInteger(id)) {
    return res.status(400).json({
      message: "消息编号不正确。"
    });
  }

  const result = db.prepare(`
    UPDATE item_responses

    SET owner_read_at = COALESCE(
      owner_read_at,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )

    WHERE id = ?
      AND EXISTS (
        SELECT 1
        FROM items
        WHERE items.id = item_responses.item_id
          AND items.user_id = ?
      )
  `).run(id, req.currentUser.id);

  if (Number(result.changes) === 0) {
    return res.status(404).json({
      message: "消息不存在或无权操作。"
    });
  }

  res.json({
    message: "已标记为已读。"
  });
});

// 九、提供测试页面。
app.use(express.static(path.join(__dirname, "public")));

// 十、统一处理错误。
app.use(function (error, req, res, next) {
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({
      message: "请求内容不是有效的 JSON。"
    });
  }

  if (error.type === "entity.too.large") {
    return res.status(413).json({
      message: "请求内容过大。"
    });
  }

  console.error("请求处理失败：", error);

  res.status(500).json({
    message: "服务器处理失败，请查看后端终端。"
  });
});

app.listen(PORT, HOST, function () {
  console.log(`后端检查地址：${BASE_URL}/api/health`);
  console.log(`注册登录测试：${BASE_URL}/test.html`);
  console.log(`物品接口测试：${BASE_URL}/items-test.html`);
});