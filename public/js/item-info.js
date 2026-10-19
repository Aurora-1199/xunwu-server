(function () {
  const categoryNames = {
    card: "证件卡片",
    electronics: "电子数码",
    daily: "生活用品",
    study: "学习用品",
    clothing: "服饰配件",
    other: "其他",
    uncategorized: "未分类"
  };

  function categoryLabel(code) {
    return categoryNames[code] || "未分类";
  }

  function formatTime(value) {
    if (!value) return "未填写";

    const date = new Date(value);

    if (!Number.isFinite(date.getTime())) {
      return "未填写";
    }

    return date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }

  // 将当前时间转换成日期输入框需要的本地时间格式。
  function localNow() {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60 * 1000;

    return new Date(now.getTime() - offset)
      .toISOString()
      .slice(0, 16);
  }

  window.xunwuItemInfo = {
    categoryLabel,
    formatTime,
    localNow
  };
})();