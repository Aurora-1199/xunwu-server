(function () {
  const button = document.querySelector("#notifications-button");
  const badge = document.querySelector("#notification-count");
  const dialog = document.querySelector("#notification-dialog");
  const list = document.querySelector("#notification-list");
  const message = document.querySelector("#notification-message");
  const closeButton = document.querySelector("#close-notifications");

  // 如果漏掉 HTML 元素，明确提示，避免按钮卡住。
  if (!button || !badge || !dialog || !list || !message || !closeButton) {
    console.error("消息功能缺少 HTML 元素，请检查消息入口和弹窗代码。");
    return;
  }

  let notifications = [];
  let requestVersion = 0;

  async function request(url, method = "GET") {
    const controller = new AbortController();
    const timer = setTimeout(function () {
      controller.abort();
    }, 10000);

    try {
      const response = await fetch(url, {
        method: method,
        credentials: "same-origin",
        signal: controller.signal
      });

      const data = await response.json().catch(function () {
        return {
          message: "消息接口异常，请确认后端已更新并重启。"
        };
      });

      if (!response.ok) {
        if (response.status === 401) {
          await window.xunwuAuth.refresh();
        }

        throw new Error(data.message || "操作失败。");
      }

      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("请求超时，请稍后再试。");
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function createElement(tag, text, className = "") {
    const element = document.createElement(tag);
    element.textContent = text;
    element.className = className;
    return element;
  }

  function renderNotifications() {
    list.replaceChildren();

    if (notifications.length === 0) {
      list.append(
        createElement("li", "暂时没有收到消息。", "notification-empty")
      );
      return;
    }

    notifications.forEach(function (record) {
      const li = createElement(
        "li",
        "",
        "notification-item" + (record.readAt ? "" : " unread")
      );

      const type = record.kind === "claim"
        ? "认领说明"
        : "物品线索";

      const heading = createElement(
        "h3",
        type + " · " + record.item.name
      );

      const meta = createElement(
        "p",
        record.author + " · " +
        new Date(record.createdAt).toLocaleString("zh-CN"),
        "notification-meta"
      );

      const content = createElement(
        "p",
        record.content,
        "notification-content"
      );

      const actions = createElement(
        "div",
        "",
        "notification-actions"
      );

      const viewButton = createElement(
        "button",
        "查看物品",
        "photo-button"
      );

      viewButton.type = "button";

      viewButton.addEventListener("click", function () {
        markRead(record, viewButton, true);
      });

      actions.append(viewButton);

      if (!record.readAt) {
        const readButton = createElement(
          "button",
          "标记已读",
          "photo-button"
        );

        readButton.type = "button";

        readButton.addEventListener("click", function () {
          markRead(record, readButton, false);
        });

        actions.append(readButton);
      } else {
        actions.append(
          createElement("span", "已读", "notification-meta")
        );
      }

      li.append(heading, meta, content, actions);
      list.append(li);
    });
  }

  async function refreshNotifications() {
    const userId = window.xunwuAuth.getCurrentUserId();

    if (userId === null) {
      return;
    }

    const version = ++requestVersion;

    try {
      const data = await request("/api/notifications");

      // 忽略旧请求，避免切换账号后显示上一账号的消息。
      if (
        version !== requestVersion ||
        userId !== window.xunwuAuth.getCurrentUserId()
      ) {
        return;
      }

      if (
        !Array.isArray(data.notifications) ||
        !Number.isInteger(data.unreadCount)
      ) {
        throw new Error("消息接口返回内容不正确。");
      }

      notifications = data.notifications;

      badge.textContent = data.unreadCount > 99
        ? "99+"
        : String(data.unreadCount);

      badge.hidden = data.unreadCount === 0;

      button.setAttribute(
        "aria-label",
        "消息，" + data.unreadCount + " 条未读"
      );

      button.title = "查看收到的认领和线索";

      if (dialog.open) {
        renderNotifications();
        message.textContent = "";
      }
    } catch (error) {
      if (
        version === requestVersion &&
        userId === window.xunwuAuth.getCurrentUserId()
      ) {
        button.title = "消息读取失败，点击重试";

        if (dialog.open) {
          message.textContent = error.message;
        }
      }
    }
  }

  async function markRead(record, clickedButton, openItem) {
    const userId = window.xunwuAuth.getCurrentUserId();
    clickedButton.disabled = true;

    try {
      await request(
        "/api/notifications/" + record.id + "/read",
        "PATCH"
      );

      if (userId !== window.xunwuAuth.getCurrentUserId()) {
        return;
      }

      await refreshNotifications();

      if (
        openItem &&
        dialog.open &&
        userId === window.xunwuAuth.getCurrentUserId()
      ) {
        dialog.close();
        window.xunwuDetails.open(record.item);
      }
    } catch (error) {
      if (
        dialog.open &&
        userId === window.xunwuAuth.getCurrentUserId()
      ) {
        message.textContent = error.message;
      }
    } finally {
      clickedButton.disabled = false;
    }
  }

  button.addEventListener("click", function () {
    if (!window.xunwuAuth.isLoggedIn()) {
      window.xunwuAuth.open();
      return;
    }

    list.replaceChildren();
    message.textContent = "正在读取消息……";

    if (!dialog.open) {
      dialog.showModal();
    }

    refreshNotifications();
  });

  closeButton.addEventListener("click", function () {
    dialog.close();
  });

  function syncAccount() {
    requestVersion += 1;
    notifications = [];
    list.replaceChildren();
    message.textContent = "";

    badge.textContent = "0";
    badge.hidden = true;
    button.setAttribute("aria-label", "消息");

    if (dialog.open) {
      dialog.close();
    }

    button.hidden = !window.xunwuAuth.isLoggedIn();

    if (window.xunwuAuth.isLoggedIn()) {
      refreshNotifications();
    }
  }

  document.addEventListener("xunwu-auth-change", syncAccount);
  window.xunwuAuth.ready.then(syncAccount);

  setInterval(function () {
    if (
      document.visibilityState === "visible" &&
      window.xunwuAuth.isLoggedIn()
    ) {
      refreshNotifications();
    }
  }, 30000);

  document.addEventListener("visibilitychange", function () {
    if (
      document.visibilityState === "visible" &&
      window.xunwuAuth.isLoggedIn()
    ) {
      refreshNotifications();
    }
  });
})();