// 使用独立作用域，避免与 app.js 中的变量重名。
(function () {
  const authDialog = document.querySelector("#auth-dialog");
  const authTitle = document.querySelector("#auth-title");
  const authForm = document.querySelector("#auth-form");

  const usernameInput = document.querySelector("#auth-username");
  const passwordInput = document.querySelector("#auth-password");
  const confirmInput = document.querySelector("#auth-confirm");
  const confirmField = document.querySelector("#confirm-field");

  const loginTab = document.querySelector("#login-tab");
  const registerTab = document.querySelector("#register-tab");
  const submitButton = document.querySelector("#auth-submit");
  const closeButton = document.querySelector("#close-auth");
  const message = document.querySelector("#auth-message");

  const openButton = document.querySelector("#open-auth");
  const userInfo = document.querySelector("#user-info");
  const userName = document.querySelector("#user-name");
  const logoutButton = document.querySelector("#logout-button");
  const pageFeedback = document.querySelector("#feedback");

  let mode = "login";
  let currentUser = null;
  let busy = false;

  function showMessage(text, isError = false) {
    message.textContent = text;
    message.classList.toggle("is-error", isError);
  }

  // 向本机后端发送请求。
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
      throw new Error(
        "无法连接后端，请确认服务正在运行，并通过后端地址打开首页。"
      );
    }

    let data;

    try {
      data = await response.json();
    } catch (error) {
      throw new Error(
        "接口没有返回有效数据，请检查后端是否正确启动。"
      );
    }

    if (!response.ok) {
      const error = new Error(data.message || "请求失败。");
      error.status = response.status;
      throw error;
    }

    return data;
  }

  function setMode(nextMode) {
    mode = nextMode;
    authForm.reset();

    const isRegister = mode === "register";

    authTitle.textContent =
      isRegister ? "创建账号" : "欢迎回来";

    submitButton.textContent =
      isRegister ? "注册" : "登录";

    confirmField.hidden = !isRegister;
    confirmInput.disabled = !isRegister;
    confirmInput.required = isRegister;

    passwordInput.autocomplete =
      isRegister ? "new-password" : "current-password";

    loginTab.classList.toggle("selected", !isRegister);
    registerTab.classList.toggle("selected", isRegister);

    loginTab.setAttribute("aria-pressed", String(!isRegister));
    registerTab.setAttribute("aria-pressed", String(isRegister));

    showMessage("");
  }

  function setBusy(value) {
    busy = value;
    submitButton.disabled = value;
    loginTab.disabled = value;
    registerTab.disabled = value;
    closeButton.disabled = value;
  }

  function updateHeader() {
    const loggedIn = currentUser !== null;

    openButton.hidden = loggedIn;
    userInfo.hidden = !loggedIn;

    userName.textContent = loggedIn
      ? currentUser.username
      : "";

    userName.title = loggedIn
      ? currentUser.username
      : "";

    document.dispatchEvent(new Event("xunwu-auth-change"));
  }

  // 页面刷新后，询问后端当前是否已经登录。
  async function restoreSession() {
    openButton.disabled = true;
    openButton.textContent = "检查登录中";

    try {
      const data = await request("/api/auth/me");
      currentUser = data.user;
    } catch (error) {
      currentUser = null;

      // 401 只是未登录，不是服务器故障。
      if (error.status !== 401) {
        pageFeedback.textContent = error.message;
      }
    } finally {
      openButton.disabled = false;
      openButton.textContent = "登录 / 注册";
      updateHeader();
    }
  }

  async function openAuth() {
    await initialization;

    // 如果等待期间已经恢复了登录，不再打开登录窗口。
    if (currentUser) {
      pageFeedback.textContent =
        "已恢复登录，请再次选择你要进行的操作。";
      return;
    }

    if (authDialog.open) {
      return;
    }

    setMode("login");
    authDialog.showModal();
    usernameInput.focus();
  }

  openButton.addEventListener("click", openAuth);

  closeButton.addEventListener("click", function () {
    authDialog.close();
  });

  authDialog.addEventListener("cancel", function (event) {
    if (busy) {
      event.preventDefault();
    }
  });

  authDialog.addEventListener("close", function () {
    authForm.reset();
    showMessage("");
  });

  loginTab.addEventListener("click", function () {
    setMode("login");
  });

  registerTab.addEventListener("click", function () {
    setMode("register");
  });

  authForm.addEventListener("submit", async function (event) {
    event.preventDefault();

    if (busy) {
      return;
    }

    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (mode === "register" && password !== confirmInput.value) {
      showMessage("两次输入的密码不一致。", true);
      return;
    }

    setBusy(true);
    showMessage("正在处理，请稍候……");

    try {
      if (mode === "register") {
        const data = await request(
          "/api/auth/register",
          "POST",
          {
            username: username,
            password: password
          }
        );

        setMode("login");
        usernameInput.value = data.user.username;

        showMessage("注册成功，请输入刚才的密码登录。");
        passwordInput.focus();
      } else {
        const data = await request(
          "/api/auth/login",
          "POST",
          {
            username: username,
            password: password
          }
        );

        currentUser = data.user;

        updateHeader();
        authDialog.close();

        pageFeedback.textContent =
          "登录成功，当前账号：" + currentUser.username;
      }
    } catch (error) {
      showMessage(error.message, true);
    } finally {
      setBusy(false);
    }
  });

  logoutButton.addEventListener("click", async function () {
    logoutButton.disabled = true;

    try {
      await request("/api/auth/logout", "POST");

      currentUser = null;
      updateHeader();

      pageFeedback.textContent = "已退出登录。";
    } catch (error) {
      pageFeedback.textContent = error.message;
    } finally {
      logoutButton.disabled = false;
    }
  });

  const initialization = restoreSession();

  // 保留原来的方法名，继续兼容 app.js 和 details.js。
  window.xunwuAuth = {
    isLoggedIn: function () {
      return currentUser !== null;
    },

    getCurrentUser: function () {
      return currentUser ? currentUser.username : null;
    },

    getCurrentUserId: function () {
      return currentUser ? currentUser.id : null;
    },

    open: openAuth,

    refresh: restoreSession,

    ready: initialization
  };
})();