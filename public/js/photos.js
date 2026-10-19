(function () {
  const entryDialog = document.querySelector("#entry-dialog");
  const entryForm = document.querySelector("#entry-form");
  const entrySubmit = entryForm.querySelector('[type="submit"]');

  const cameraInput = document.querySelector("#camera-input");
  const albumInput = document.querySelector("#album-input");
  const cameraButton = document.querySelector("#take-photo");
  const albumButton = document.querySelector("#choose-photo");

  const previewArea = document.querySelector("#photo-preview-area");
  const preview = document.querySelector("#photo-preview");
  const photoMessage = document.querySelector("#photo-message");
  const recropButton = document.querySelector("#recrop-photo");

  const cropDialog = document.querySelector("#crop-dialog");
  const canvas = document.querySelector("#crop-canvas");
  const context = canvas.getContext("2d");
  const zoomInput = document.querySelector("#crop-zoom");
  const zoomValue = document.querySelector("#crop-zoom-value");
  const cropMessage = document.querySelector("#crop-message");

  // selected：已经确认的照片。
  // draft：正在裁剪、尚未确认的照片。
  let selected = null;
  let draft = null;

  let loading = false;
  let requestId = 0;
  let pendingUrl = "";
  let drag = null;

  let baseScale = 1;
  let scale = 1;
  let x = 0;
  let y = 0;

  function setLoading(value) {
    loading = value;
    cameraButton.disabled = value;
    albumButton.disabled = value;
    recropButton.disabled = value;
    entrySubmit.disabled = value;
  }

  // 限制图片位置，避免拖出空白区域。
  function clampPosition() {
    const width = draft.image.naturalWidth * scale;
    const height = draft.image.naturalHeight * scale;

    x = Math.min(0, Math.max(canvas.width - width, x));
    y = Math.min(0, Math.max(canvas.height - height, y));
  }

  function draw() {
    if (!draft) {
      return;
    }

    clampPosition();

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.drawImage(
      draft.image,
      x,
      y,
      draft.image.naturalWidth * scale,
      draft.image.naturalHeight * scale
    );
  }

  function resetPosition() {
    if (!draft) {
      return;
    }

    baseScale = Math.max(
      canvas.width / draft.image.naturalWidth,
      canvas.height / draft.image.naturalHeight
    );

    scale = baseScale;
    x = (canvas.width - draft.image.naturalWidth * scale) / 2;
    y = (canvas.height - draft.image.naturalHeight * scale) / 2;

    zoomInput.value = "1";
    zoomValue.value = "1.00×";

    draw();
  }

  function openCrop() {
    drag = null;
    cropMessage.textContent = "";
    resetPosition();
    cropDialog.showModal();
  }

  // 取消新照片时释放临时地址。
  // 重新裁剪原照片时，原照片仍然保留。
  function discardDraft() {
    if (draft && draft.isNew) {
      URL.revokeObjectURL(draft.sourceUrl);
    }

    draft = null;
    drag = null;
    context.clearRect(0, 0, canvas.width, canvas.height);
  }

  function cancelCrop() {
    discardDraft();
    cropDialog.close();
  }

  function resetPhoto() {
    requestId += 1;

    if (pendingUrl) {
      URL.revokeObjectURL(pendingUrl);
      pendingUrl = "";
    }

    discardDraft();

    if (cropDialog.open) {
      cropDialog.close();
    }

    if (selected) {
      URL.revokeObjectURL(selected.sourceUrl);
    }

    selected = null;

    preview.removeAttribute("src");
    previewArea.hidden = true;
    cameraInput.value = "";
    albumInput.value = "";
    photoMessage.textContent = "";

    setLoading(false);
  }

  async function readPhoto(event) {
    const input = event.target;
    const file = input.files[0];

    // 允许下一次再次选择同一个文件。
    input.value = "";

    if (!file) {
      return;
    }

    if (!file.type.startsWith("image/")) {
      photoMessage.textContent = "请选择图片文件。";
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      photoMessage.textContent = "照片超过 10MB，请选择较小的图片。";
      return;
    }

    const thisRequest = ++requestId;
    const sourceUrl = URL.createObjectURL(file);

    pendingUrl = sourceUrl;
    setLoading(true);
    photoMessage.textContent = "正在读取照片……";

    try {
      const image = new Image();
image.decoding = "async";

// 等待图片加载，最多等待 15 秒。
await new Promise(function (resolve, reject) {
  let finished = false;
  let timer;

  function finish(error) {
    if (finished) {
      return;
    }

    finished = true;
    clearTimeout(timer);

    image.onload = null;
    image.onerror = null;

    if (error) {
      reject(error);
    } else {
      resolve();
    }
  }

  image.onload = function () {
    if (!image.naturalWidth || !image.naturalHeight) {
      finish(new Error("图片尺寸无效，请更换照片。"));
      return;
    }

    finish();
  };

  image.onerror = function () {
    finish(new Error(
      "浏览器无法读取这张照片，请尝试普通 JPG 或 PNG 图片。"
    ));
  };

  timer = setTimeout(function () {
    finish(new Error(
      "照片读取超时。请先用一张小于 2MB 的本地 JPG 或 PNG 图片测试。"
    ));

    image.removeAttribute("src");
  }, 15000);

  image.src = sourceUrl;
});

      // 如果期间关闭了登记窗口，就不再打开裁剪窗口。
      if (thisRequest !== requestId || !entryDialog.open) {
        URL.revokeObjectURL(sourceUrl);
        return;
      }

      draft = {
        image: image,
        sourceUrl: sourceUrl,
        isNew: true
      };

      pendingUrl = "";
      openCrop();
      photoMessage.textContent = "";
    } catch (error) {
      if (draft && draft.sourceUrl === sourceUrl) {
        discardDraft();
      }

      URL.revokeObjectURL(sourceUrl);

      if (thisRequest === requestId) {
        console.error("照片读取失败：", error);

        photoMessage.textContent =
          error.message || "读取失败，请重新选择照片。";
      } 
    } finally {
      if (thisRequest === requestId) {
        pendingUrl = "";
        setLoading(false);
      }
    }
  }

  cameraButton.addEventListener("click", function () {
    cameraInput.click();
  });

  albumButton.addEventListener("click", function () {
    albumInput.click();
  });

  cameraInput.addEventListener("change", readPhoto);
  albumInput.addEventListener("change", readPhoto);

  recropButton.addEventListener("click", function () {
    if (!selected) {
      return;
    }

    draft = {
      image: selected.image,
      sourceUrl: selected.sourceUrl,
      isNew: false
    };

    openCrop();
  });

  document.querySelector("#remove-photo")
    .addEventListener("click", resetPhoto);

  document.querySelector("#close-crop")
    .addEventListener("click", cancelCrop);

  cropDialog.addEventListener("cancel", function (event) {
    event.preventDefault();
    cancelCrop();
  });

  document.querySelector("#reset-crop")
    .addEventListener("click", resetPosition);

  // 缩放时，以画面中心为基准调整位置。
  zoomInput.addEventListener("input", function () {
    if (!draft) {
      return;
    }

    const nextScale = baseScale * Number(zoomInput.value);
    const ratio = nextScale / scale;

    x = canvas.width / 2 - (canvas.width / 2 - x) * ratio;
    y = canvas.height / 2 - (canvas.height / 2 - y) * ratio;
    scale = nextScale;

    zoomValue.value = Number(zoomInput.value).toFixed(2) + "×";
    draw();
  });

  // 鼠标和手机手指共用拖动逻辑。
  canvas.addEventListener("pointerdown", function (event) {
    if (!draft || !event.isPrimary || event.button !== 0) {
      return;
    }

    drag = {
      id: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY
    };

    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", function (event) {
    if (!drag || drag.id !== event.pointerId || !draft) {
      return;
    }

    const rect = canvas.getBoundingClientRect();

    x += (event.clientX - drag.lastX) * canvas.width / rect.width;
    y += (event.clientY - drag.lastY) * canvas.height / rect.height;

    drag.lastX = event.clientX;
    drag.lastY = event.clientY;

    draw();
  });

  function stopDrag() {
    drag = null;
  }

  canvas.addEventListener("pointerup", stopDrag);
  canvas.addEventListener("pointercancel", stopDrag);
  canvas.addEventListener("lostpointercapture", stopDrag);

  // 支持用方向键微调位置。
  canvas.addEventListener("keydown", function (event) {
    if (!draft) {
      return;
    }

    const moves = {
      ArrowLeft: [-10, 0],
      ArrowRight: [10, 0],
      ArrowUp: [0, -10],
      ArrowDown: [0, 10]
    };

    const move = moves[event.key];

    if (move) {
      event.preventDefault();
      x += move[0];
      y += move[1];
      draw();
    }
  });

  document.querySelector("#confirm-crop")
    .addEventListener("click", function () {
      if (!draft) {
        return;
      }

      try {
        // 输出固定 800×600 的图片，辅助线不会被保存。
        const photo = canvas.toDataURL("image/jpeg", 0.88);

        if (photo === "data:,") {
          throw new Error("图片生成失败");
        }

        if (selected && selected.sourceUrl !== draft.sourceUrl) {
          URL.revokeObjectURL(selected.sourceUrl);
        }

        selected = {
          image: draft.image,
          sourceUrl: draft.sourceUrl,
          photo: photo
        };

        draft = null;
        drag = null;
        context.clearRect(0, 0, canvas.width, canvas.height);

        preview.src = photo;
        previewArea.hidden = false;
        photoMessage.textContent = "照片已裁剪，可以继续填写并提交。";

        cropDialog.close();
      } catch (error) {
        cropMessage.textContent = "裁剪未完成，请重试或更换照片。";
      }
    });

  // 打开新登记、取消登记时，清除上一次的照片。
  entryForm.addEventListener("reset", resetPhoto);
  entryDialog.addEventListener("close", resetPhoto);

  // 照片还在读取时，阻止按回车直接提交。
  entryForm.addEventListener("submit", function (event) {
    if (loading || cropDialog.open) {
      event.preventDefault();
      event.stopImmediatePropagation();
      photoMessage.textContent = "请先完成照片读取和裁剪。";
    }
  }, true);

  // app.js 提交物品时，从这里读取裁剪结果。
  window.xunwuPhotos = {
    getPhoto: function () {
      return selected ? selected.photo : "";
    }
  };
})();