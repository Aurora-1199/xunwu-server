(function () {
  const dialog = document.querySelector("#detail-dialog");
  const title = document.querySelector("#detail-title");
  const status = document.querySelector("#detail-status");
  const place = document.querySelector("#detail-place");
  const description = document.querySelector("#detail-description");
  const categoryText = document.querySelector("#detail-category");
  const eventTimeText = document.querySelector("#detail-event-time");
  const eventTimeLabel = document.querySelector("#detail-event-time-label");

  const photo = document.querySelector("#detail-photo");
  const placeholder = document.querySelector("#detail-placeholder");
  const icon = document.querySelector("#detail-icon");

  const actionButton = document.querySelector("#detail-action");
  const form = document.querySelector("#detail-response-form");
  const label = document.querySelector("#detail-response-label");
  const input = document.querySelector("#detail-response");
  const message = document.querySelector("#detail-message");

  const submitButton = form.querySelector('[type="submit"]');
  const cancelButton = document.querySelector("#cancel-response");
  const closeButton = document.querySelector("#close-detail");

  const history = document.querySelector("#detail-history");
  const historyTitle = document.querySelector("#detail-history-title");
  const recordList = document.querySelector("#detail-records");

  let currentItem = null;
  let busy = false;
  let viewVersion = 0;
  let listVersion = 0;

  async function request(url, method = "GET", body) {
    const options = {
      method: method,
      credentials: "same-origin"
    };

    if (body !== undefined) {
      options.headers = {
        "Content-Type": "application/json"
      };
      options.body = JSON.stringify(body);
    }

    let response;

    try {
      response = await fetch(url, options);
    } catch (error) {
      throw new Error("无法连接后端，请确认服务正在运行。");
    }

    const data = await response.json().catch(function () {
      return {
        message: "接口返回异常，请确认后端已更新并重启。"
      };
    });

    if (!response.ok) {
      if (response.status === 401) {
        await window.xunwuAuth.refresh();
      }

      throw new Error(data.message || "请求失败，请重试。");
    }

    return data;
  }

  function isCurrent(view, itemId) {
    return (
      view === viewVersion &&
      dialog.open &&
      currentItem !== null &&
      currentItem.id === itemId
    );
  }

  function isOwner() {
    return currentItem &&
      currentItem.ownerId === window.xunwuAuth.getCurrentUserId();
  }

  function finishedText() {
    return currentItem.kind === "lost" ? "已找回" : "已归还";
  }

  function showNotice() {
    if (currentItem.status === "resolved") {
      message.textContent = "信息已结束，可以查看已有记录，不能新增提交。";
    } else if (isOwner()) {
      message.textContent = "这是你发布的信息，下方可以查看收到的提交。";
    } else if (!window.xunwuAuth.isLoggedIn()) {
      message.textContent = "登录后可以提交，并查看自己的提交记录。";
    } else {
      message.textContent = "";
    }
  }

  function updateState() {
    if (!currentItem) {
      return;
    }

    const ended = currentItem.status === "resolved";
    const own = isOwner();

    status.className = "item-status";

    if (ended) {
      status.textContent = finishedText();
      status.classList.add("is-resolved");
    } else {
      status.textContent =
        currentItem.kind === "lost" ? "寻物启事" : "拾获招领";

      if (currentItem.kind === "lost") {
        status.classList.add("is-lost");
      }
    }

    if (ended || own) {
      form.hidden = true;
    }

    actionButton.textContent = ended
      ? finishedText()
      : own
        ? "这是你发布的信息"
        : currentItem.kind === "found"
          ? "我要认领"
          : "我有线索";

    actionButton.disabled = busy || ended || own;
    actionButton.hidden = !form.hidden;
  }

  function setBusy(value) {
    busy = value;
    submitButton.disabled = value;
    cancelButton.disabled = value;
    closeButton.disabled = value;
    input.disabled = value;
    updateState();
  }

  function canRespond() {
    if (!currentItem) {
      return false;
    }

    if (
      currentItem.status === "resolved" ||
      isOwner()
    ) {
      updateState();
      showNotice();
      return false;
    }

    if (!window.xunwuAuth.isLoggedIn()) {
      message.textContent = "请先登录，登录后重新打开物品详情。";
      window.xunwuAuth.open();
      return false;
    }

    return true;
  }

  function renderRecords(data) {
    recordList.replaceChildren();

    historyTitle.textContent = data.scope === "received"
      ? "收到的提交记录"
      : "我的提交记录";

    if (data.records.length === 0) {
      const empty = document.createElement("li");

      empty.textContent = data.scope === "received"
        ? "暂时没有收到提交。"
        : "你还没有提交记录。";

      recordList.append(empty);
      return;
    }

    data.records.forEach(function (record) {
      const li = document.createElement("li");
      const heading = document.createElement("strong");
      const time = document.createElement("p");
      const content = document.createElement("p");

      heading.textContent =
        (record.kind === "claim" ? "认领说明" : "物品线索") +
        " · " + record.author;

      time.textContent =
        new Date(record.createdAt).toLocaleString("zh-CN");

      content.textContent = record.content;

      li.append(heading, time, content);
      recordList.append(li);
    });
  }

  async function loadRecords() {
    if (!currentItem || !dialog.open) {
      return false;
    }

    const view = viewVersion;
    const itemId = currentItem.id;
    const task = ++listVersion;

    recordList.replaceChildren();
    history.hidden = true;

    await window.xunwuAuth.ready;

    if (!isCurrent(view, itemId) || task !== listVersion) {
      return false;
    }

    if (!window.xunwuAuth.isLoggedIn()) {
      return true;
    }

    history.hidden = false;
    historyTitle.textContent = "正在读取提交记录……";

    try {
      const data = await request(
        "/api/items/" + itemId + "/responses"
      );

      if (!isCurrent(view, itemId) || task !== listVersion) {
        return false;
      }

      if (!Array.isArray(data.records) || !data.item) {
        throw new Error("记录接口返回异常，请检查后端代码。");
      }

      // 使用后端返回的最新状态。
      Object.assign(currentItem, data.item);

      updateState();
      renderRecords(data);

      if (currentItem.status === "resolved" || isOwner()) {
        showNotice();
      }

      return true;
    } catch (error) {
      if (isCurrent(view, itemId) && task === listVersion) {
        historyTitle.textContent = "提交记录";
        recordList.replaceChildren();
        message.textContent = error.message;
      }

      return false;
    }
  }

  function openDetails(item) {
    viewVersion += 1;
    listVersion += 1;
    currentItem = { ...item };

    form.reset();
    form.hidden = true;
    input.setCustomValidity("");

    recordList.replaceChildren();
    history.hidden = true;

    title.textContent = item.name;
    place.textContent = item.place;
    description.textContent = item.description || "暂无补充描述。";
    categoryText.textContent =
      window.xunwuItemInfo.categoryLabel(item.category);

    eventTimeText.textContent =
      window.xunwuItemInfo.formatTime(item.eventAt);

    eventTimeLabel.textContent =
      item.kind === "lost" ? "遗失时间" : "拾获时间";

    if (item.photo) {
      photo.src = item.photo;
      photo.alt = item.name;
      photo.hidden = false;
      placeholder.hidden = true;
    } else {
      photo.removeAttribute("src");
      photo.hidden = true;
      placeholder.hidden = false;

      icon.setAttribute("href", "#icon-" + (item.icon || "box"));
    }

    label.textContent = item.kind === "found"
      ? "请描述你的认领依据"
      : "请描述你掌握的线索";

    input.placeholder = item.kind === "found"
      ? "例如：物品有哪些未展示的特征？填写 6—300 字"
      : "例如：何时、在哪里看到过物品？填写 6—300 字";

    setBusy(false);
    showNotice();

    if (!dialog.open) {
      dialog.showModal();
    }

    dialog.scrollTop = 0;
    loadRecords();
  }

  actionButton.addEventListener("click", function () {
    if (busy || !canRespond()) {
      return;
    }

    form.hidden = false;
    message.textContent = "";
    updateState();
    input.focus();
  });

  cancelButton.addEventListener("click", function () {
    form.reset();
    input.setCustomValidity("");
    form.hidden = true;

    updateState();
    showNotice();
    actionButton.focus();
  });

  input.addEventListener("input", function () {
    input.setCustomValidity("");
  });

  form.addEventListener("submit", async function (event) {
    event.preventDefault();

    if (busy || !canRespond()) {
      return;
    }

    const content = input.value.trim();

    input.setCustomValidity(
      content.length >= 6 && content.length <= 300
        ? ""
        : "请填写 6—300 字的有效内容。"
    );

    if (!form.reportValidity()) {
      return;
    }

    const view = viewVersion;
    const itemId = currentItem.id;

    setBusy(true);
    message.textContent = "正在保存……";

    try {
      await request(
        "/api/items/" + itemId + "/responses",
        "POST",
        { content: content }
      );

      if (!isCurrent(view, itemId)) {
        return;
      }

      form.reset();
      form.hidden = true;

      const loaded = await loadRecords();

      if (isCurrent(view, itemId)) {
        message.textContent = loaded
          ? "提交已保存，物品发布者可以在详情页查看。"
          : "提交已保存，但记录读取失败，请关闭后重新打开详情。";
      }
    } catch (error) {
      if (isCurrent(view, itemId)) {
        await loadRecords();

        if (isCurrent(view, itemId)) {
          message.textContent = error.message;
        }
      }
    } finally {
      if (isCurrent(view, itemId)) {
        setBusy(false);
      }
    }
  });

  closeButton.addEventListener("click", function () {
    if (!busy) {
      dialog.close();
    }
  });

  dialog.addEventListener("cancel", function (event) {
    if (busy) {
      event.preventDefault();
    }
  });

  dialog.addEventListener("close", function () {
    viewVersion += 1;
    listVersion += 1;
    currentItem = null;

    form.reset();
    form.hidden = true;
    input.setCustomValidity("");

    recordList.replaceChildren();
    history.hidden = true;
    photo.removeAttribute("src");
    message.textContent = "";

    setBusy(false);
  });

  // 切换账号后重新打开详情，读取对应账号有权限查看的记录。
  document.addEventListener("xunwu-auth-change", function () {
    if (dialog.open) {
      dialog.close();
    }
  });

  window.xunwuDetails = {
    open: openDetails
  };
})();