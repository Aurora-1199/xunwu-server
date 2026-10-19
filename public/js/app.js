(function () {
  const itemList = document.querySelector("#item-list");
  const searchForm = document.querySelector("#search-form");
  const searchInput = document.querySelector("#search-input");
  const resultCount = document.querySelector("#result-count");
  const emptyState = document.querySelector("#empty-state");
  const feedback = document.querySelector("#feedback");
  const filterButtons = document.querySelectorAll("[data-filter]");

  const dialog = document.querySelector("#entry-dialog");
  const dialogTitle = document.querySelector("#dialog-title");
  const entryForm = document.querySelector("#entry-form");
  const nameInput = document.querySelector("#item-name");
  const placeInput = document.querySelector("#item-place");
  const descriptionInput = document.querySelector("#item-description");
  const categoryInput = document.querySelector("#item-category");
  const eventTimeInput = document.querySelector("#item-event-time");
  const eventTimeLabel = document.querySelector("#item-event-time-label");
  const entryMessage = document.querySelector("#entry-message");
  const entrySubmit = entryForm.querySelector('[type="submit"]');
  const closeDialog = document.querySelector("#close-dialog");

  const pagination = document.querySelector("#pagination");
  const previousPage = document.querySelector("#previous-page");
  const nextPage = document.querySelector("#next-page");
  const pageInformation = document.querySelector("#page-information");

  let items = [];
  let total = 0;
  let pageSize = 20;
  let page = 1;
  let currentFilter = "all";
  let currentKind = "lost";
  let initialized = false;
  let publishing = false;
  let loadVersion = 0;
  let searchTimer;

  // 所有物品请求都发送给当前地址对应的后端。
  async function request(url, method = "GET", body) {
    const options = {
      method: method,
      credentials: "same-origin"
    };

    if (body !== undefined) {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(body);
    }

    let response;

    try {
      response = await fetch(url, options);
    } catch (error) {
      throw new Error("无法连接后端，请确认服务正在运行。");
    }

    let data;

    try {
      data = await response.json();
    } catch (error) {
      throw new Error("接口返回异常，请检查后端代码和访问地址。");
    }

    if (!response.ok) {
      if (response.status === 401) {
        await window.xunwuAuth.refresh();
      }

      throw new Error(data.message || "操作失败，请重试。");
    }

    return data;
  }

  function createElement(tag, className, text = "") {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
  }

  function createIcon(name, className = "icon") {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    const use = document.createElementNS(namespace, "use");

    svg.setAttribute("class", className);
    svg.setAttribute("aria-hidden", "true");
    use.setAttribute("href", "#icon-" + name);

    svg.append(use);
    return svg;
  }

  function isMyItem(item) {
    const userId = window.xunwuAuth.getCurrentUserId();

    return userId !== null && item.ownerId === userId;
  }

  function updateFilterButtons() {
    filterButtons.forEach(function (button) {
      const selected = button.dataset.filter === currentFilter;

      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }

  function renderItems() {
    itemList.replaceChildren();

    items.forEach(function (item) {
      itemList.append(createItemCard(item));
    });

    resultCount.textContent =
      "共 " + total + " 条，当前显示 " + items.length + " 条";

    emptyState.hidden = total !== 0;

    const lastPage = Math.max(1, Math.ceil(total / pageSize));

    pagination.hidden = total <= pageSize;
    pageInformation.textContent = page + " / " + lastPage;
    previousPage.disabled = page <= 1;
    nextPage.disabled = page >= lastPage;
  }

  // 搜索、筛选、排序和分页由后端完成。
  async function loadItems() {
    const thisLoad = ++loadVersion;

    itemList.replaceChildren();
    emptyState.hidden = true;
    pagination.hidden = true;
    resultCount.textContent = "正在读取数据库……";

    const query = new URLSearchParams({
      q: searchInput.value.trim(),
      page: String(page),
      kind: ["lost", "found"].includes(currentFilter)
        ? currentFilter
        : "all"
    });

    const endpoint = currentFilter === "mine"
      ? "/api/items/mine"
      : "/api/items";

    try {
      const data = await request(endpoint + "?" + query.toString());

      // 忽略已经过时的搜索结果。
      if (thisLoad !== loadVersion) {
        return;
      }

      items = data.items;
      total = data.total;
      pageSize = data.pageSize;

      const lastPage = Math.max(1, Math.ceil(total / pageSize));

      // 删除某页最后一条后，返回仍然存在的页码。
      if (page > lastPage) {
        page = lastPage;
        return loadItems();
      }

      renderItems();
    } catch (error) {
      if (thisLoad !== loadVersion) {
        return;
      }

      items = [];
      resultCount.textContent = "读取失败";
      feedback.textContent = error.message;
    }
  }

  function createItemCard(item) {
    const card = createElement("article", "item-card");
    const visual = createElement("div", "item-visual");

    if (item.photo) {
      visual.classList.add("has-photo");

      const photo = createElement("img", "item-photo");
      photo.src = item.photo;
      photo.alt = item.name;

      visual.append(photo);
    } else {
      visual.append(createIcon("box", "item-icon"));
    }

    const content = createElement("div", "item-content");
    const meta = createElement("div", "item-meta");
    const finished = item.status === "resolved";

    const statusText = finished
      ? (item.kind === "lost" ? "已找回" : "已归还")
      : (item.kind === "lost" ? "寻物启事" : "拾获招领");

    const statusClass = finished
      ? "item-status is-resolved"
      : (item.kind === "lost"
          ? "item-status is-lost"
          : "item-status");

    meta.append(
      createElement("span", statusClass, statusText),
      createElement(
        "span",
        "item-demo",
        window.xunwuItemInfo.categoryLabel(item.category)
      )
    );

    const location = createElement("p", "item-location");

    location.append(
      createIcon("pin"),
      createElement("span", "", item.place)
    );

    content.append(
      meta,
      createElement("h3", "", item.name),
      location,
      createElement(
        "p",
        "item-event-time",
        (item.kind === "lost" ? "遗失时间：" : "拾获时间：") +
          window.xunwuItemInfo.formatTime(item.eventAt)
      ),
      createElement("p", "item-owner", "发布者：" + item.owner),
      createElement(
        "p",
        "item-description",
        item.description || "暂无补充描述。"
      )
    );

    const detailButton = createElement(
      "button",
      "details-button",
      "查看详情"
    );

    detailButton.type = "button";
    detailButton.setAttribute("aria-label", "查看" + item.name + "的详情");

    detailButton.addEventListener("click", function () {
      window.xunwuDetails.open(item);
    });

    content.append(detailButton);

    if (isMyItem(item)) {
      const completeButton = createElement(
        "button",
        "complete-item-button",
        finished
          ? "恢复为进行中"
          : (item.kind === "lost" ? "确认已找回" : "确认已归还")
      );

      completeButton.type = "button";

      completeButton.addEventListener("click", async function () {
        if (!window.confirm(
          finished ? "确定恢复为进行中吗？" : "确定这条信息已经完成吗？"
        )) {
          return;
        }

        completeButton.disabled = true;

        try {
          await request(
            "/api/items/" + item.id + "/status",
            "PATCH",
            { status: finished ? "open" : "resolved" }
          );

          feedback.textContent = finished
            ? "已恢复为进行中。"
            : "完成状态已保存，已结束的信息排在列表最后。";

          await loadItems();
        } catch (error) {
          feedback.textContent = error.message;
        } finally {
          completeButton.disabled = false;
        }
      });

      const deleteButton = createElement(
        "button",
        "delete-item-button",
        "删除我的发布"
      );

      deleteButton.type = "button";

      deleteButton.addEventListener("click", async function () {
        if (!window.confirm("确定从数据库删除这条信息吗？")) {
          return;
        }

        deleteButton.disabled = true;

        try {
          await request("/api/items/" + item.id, "DELETE");

          feedback.textContent = "已从数据库删除这条信息。";
          await loadItems();
        } catch (error) {
          feedback.textContent = error.message;
        } finally {
          deleteButton.disabled = false;
        }
      });

      content.append(completeButton, deleteButton);
    }

    card.append(visual, content);
    return card;
  }

  async function setFilter(filter) {
    await window.xunwuAuth.ready;

    if (filter === "mine" && !window.xunwuAuth.isLoggedIn()) {
      window.xunwuAuth.open();
      return;
    }

    currentFilter = filter;
    page = 1;
    feedback.textContent = "";

    updateFilterButtons();
    loadItems();
  }

  filterButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      clearTimeout(searchTimer);
      setFilter(button.dataset.filter);
    });
  });

  searchForm.addEventListener("submit", function (event) {
    event.preventDefault();
    clearTimeout(searchTimer);

    page = 1;
    feedback.textContent = "";
    loadItems();
  });

  searchInput.addEventListener("input", function () {
    clearTimeout(searchTimer);

    searchTimer = setTimeout(function () {
      page = 1;
      feedback.textContent = "";
      loadItems();
    }, 300);
  });

  previousPage.addEventListener("click", function () {
    page -= 1;
    loadItems();
  });

  nextPage.addEventListener("click", function () {
    page += 1;
    loadItems();
  });

  document.querySelectorAll("[data-kind]").forEach(function (button) {
    button.addEventListener("click", async function () {
      await window.xunwuAuth.ready;

      if (!window.xunwuAuth.isLoggedIn()) {
        window.xunwuAuth.open();
        return;
      }

      currentKind = button.dataset.kind;

      entryForm.reset();
      nameInput.setCustomValidity("");
      placeInput.setCustomValidity("");
      eventTimeInput.setCustomValidity("");
      eventTimeInput.max = window.xunwuItemInfo.localNow();

      eventTimeLabel.textContent =
        currentKind === "lost"
          ? "遗失时间（选填）"
          : "拾获时间（选填）";
      entryMessage.textContent = "";

      dialogTitle.textContent =
        currentKind === "lost" ? "我丢东西了" : "我捡到东西了";

      dialog.showModal();
      nameInput.focus();
    });
  });

  closeDialog.addEventListener("click", function () {
    if (!publishing) {
      dialog.close();
    }
  });

  dialog.addEventListener("cancel", function (event) {
    if (publishing) {
      event.preventDefault();
    }
  });

  [nameInput, placeInput, eventTimeInput].forEach(function (input) {
    input.addEventListener("input", function () {
      input.setCustomValidity("");
    });
  });

  eventTimeInput.addEventListener("focus", function () {
    eventTimeInput.max = window.xunwuItemInfo.localNow();
  });

  entryForm.addEventListener("submit", async function (event) {
    event.preventDefault();

    if (publishing) {
      return;
    }

    if (!window.xunwuAuth.isLoggedIn()) {
      entryMessage.textContent = "请先登录。";
      window.xunwuAuth.open();
      return;
    }

    const name = nameInput.value.trim();
    const place = placeInput.value.trim();

    nameInput.setCustomValidity(name ? "" : "请输入物品名称。");
    placeInput.setCustomValidity(place ? "" : "请输入地点。");

    eventTimeInput.max = window.xunwuItemInfo.localNow();

    const eventDate = eventTimeInput.value
      ? new Date(eventTimeInput.value)
      : null;

    const validEventTime =
      eventDate === null ||
      (
        Number.isFinite(eventDate.getTime()) &&
        eventDate.getTime() <= Date.now()
     );

    eventTimeInput.setCustomValidity(
      validEventTime ? "" : "请选择有效时间，不能晚于当前时间。"
   );
    
    if (!entryForm.reportValidity()) {
      return;
    }

    publishing = true;
    entrySubmit.disabled = true;
    closeDialog.disabled = true;
    entryMessage.textContent = "正在保存……";

    try {
      await request("/api/items", "POST", {
        kind: currentKind,
        name,
        place,
        category: categoryInput.value,
        eventAt: eventDate ? eventDate.toISOString() : null,
        description: descriptionInput.value.trim(),
        photo: window.xunwuPhotos.getPhoto() || null
      });

      dialog.close();

      searchInput.value = "";
      currentFilter = "all";
      page = 1;
      updateFilterButtons();

      feedback.textContent = "发布成功，已保存到本机数据库。";

      await loadItems();
      document.querySelector("#square").scrollIntoView();
    } catch (error) {
      entryMessage.textContent = error.message;
    } finally {
      publishing = false;
      entrySubmit.disabled = false;
      closeDialog.disabled = false;
    }
  });

  document.addEventListener("xunwu-auth-change", function () {
    if (!initialized) {
      return;
    }

    if (currentFilter === "mine" && !window.xunwuAuth.isLoggedIn()) {
      currentFilter = "all";
      page = 1;
    }

    updateFilterButtons();
    loadItems();
  });

  document.addEventListener("DOMContentLoaded", async function () {
    await window.xunwuAuth.ready;

    initialized = true;
    updateFilterButtons();
    loadItems();
  });
})();