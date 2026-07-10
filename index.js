import {
  extension_settings,
  getContext,
} from "../../../extensions.js";

import {
  saveSettingsDebounced,
  saveChatDebounced,
  eventSource,
  event_types,
  generateRaw,
  messageFormatting,
  getCurrentChatId,
  getRequestHeaders,
} from "../../../../script.js";

import { applyLocale } from "../../../../scripts/i18n.js";

const extensionName = "st-if";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const extensionSettings = extension_settings[extensionName];

const SOURCE_MAP = {
  openai:     "openai",
  claude:     "claude",
  google:     "makersuite",
  vertexai:   "vertexai",
  deepseek:   "deepseek",
  openrouter: "openrouter",
  cohere:     "cohere",
  groq:       "groq",
  mistralai:  "mistralai",
  xai:        "xai",
};

const GEMINI_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.5-pro",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash-lite-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
];

const PRESET_MODELS = {
  openai:     ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
  claude:     ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5-20251001"],
  google:     GEMINI_MODELS,
  vertexai:   GEMINI_MODELS,
  deepseek:   ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-pro", "deepseek-v4-flash"],
  openrouter: ["google/gemini-2.5-flash-lite", "anthropic/claude-3.5-sonnet", "openai/gpt-4o-mini", "meta-llama/llama-3.1-8b-instruct"],
  cohere:     ["command-r-plus", "command-r", "command"],
  groq:       ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"],
  mistralai:  ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest"],
  xai:        ["grok-3-beta", "grok-3-mini-beta", "grok-beta"],
};

const DEFAULT_MODELS = {
  st:         "",
  openai:     "gpt-4o-mini",
  claude:     "claude-haiku-4-5-20251001",
  google:     "gemini-2.5-flash",
  vertexai:   "gemini-2.5-flash",
  deepseek:   "deepseek-chat",
  openrouter: "",
  cohere:     "command-r-plus",
  groq:       "llama-3.3-70b-versatile",
  mistralai:  "mistral-large-latest",
  xai:        "grok-3-beta",
};

const defaultSettings = {
  enabled: true,
  autoNew: false,
  autoEdit: false,
  folded: false,
  showQuickButton: true,
  quickButtonSide: "left",
  template: `Previous Messages:
{{previousMessages}}

Current Message:
{{message}}

---

{{prompt}}`,
  prompt: "Please check the message above regarding grammar and naturalness, and provide corresponding feedbacks. After that, please provide the corrected sentence. Do not change the politeness and tone of the sentence, as it is in the middle of a role play. If you didn't find a problem, please just state \"This message looks good.\" without any other comments.",
  numPrevMsgs: 5,
  provider: "st",
  model: "",
  customModel: "",
  useCustomModel: false,
};

// ── Quick Button ──────────────────────────────────────

const QUICK_BTN_ID = "input-feedback-quick-btn";

function createQuickButton() {
  $(`#${QUICK_BTN_ID}`).remove();

  const side = extension_settings[extensionName].quickButtonSide || "left";
  const $btn = $(`<div id="${QUICK_BTN_ID}" class="menu_button interactable"></div>`);

  const leftTargets  = ["#leftSendForm", "#send_form .flex-container:first", "#send_form"];
  const rightTargets = ["#rightSendForm", "#send_but_sheld", "#send_form"];
  const targets = side === "right" ? rightTargets : leftTargets;

  function tryInsert(attemptsLeft) {
    for (const sel of targets) {
      const $t = $(sel);
      if ($t.length) {
        side === "right" ? $t.prepend($btn) : $t.append($btn);
        $btn.on("click", toggleEnabled);
        updateQuickButtonState();
        return;
      }
    }
    if (attemptsLeft > 0) {
      setTimeout(() => tryInsert(attemptsLeft - 1), 300);
      return;
    }
    $btn.addClass("input-feedback-fixed-fallback");
    if (side === "right") $btn.addClass("fixed-right");
    $("body").append($btn);
    $btn.on("click", toggleEnabled);
    updateQuickButtonState();
  }

  tryInsert(10);
}

function toggleEnabled() {
  const newEnabled = !extension_settings[extensionName].enabled;
  extension_settings[extensionName].enabled = newEnabled;
  saveSettingsDebounced();
  $("#input-feedback-enabled").prop("checked", newEnabled);

  if (!newEnabled) {
    $(".mes_feedback").remove();
    toastr.info("인풋 피드백 OFF");
  } else {
    handleChatChanged();
    toastr.success("인풋 피드백 ON");
  }
  updateQuickButtonState();
}

function updateQuickButton() {
  const s = extension_settings[extensionName];
  if (s.showQuickButton) {
    createQuickButton();
  } else {
    $(`#${QUICK_BTN_ID}`).remove();
  }
  updateQuickButtonState();
}

function updateQuickButtonState() {
  const enabled = extension_settings[extensionName].enabled;
  const $btn = $(`#${QUICK_BTN_ID}`);
  $btn.toggleClass("active", enabled).toggleClass("inactive", !enabled);
  
  // ON/OFF 상태에 따라 AB 텍스트 유연하게 변경
  if (enabled) {
    $btn.text("AB");
  } else {
    $btn.text("A̶B̶");
  }
  
  $btn.attr("title", enabled ? "인풋 피드백 ON — 클릭하면 끄기" : "인풋 피드백 OFF — 클릭하면 켜기");
}

// ── 피드백 뷰어 ──────────────────────────────────────

function createFeedbackViewer() {
  if ($('#st-feedback-viewer').length) {
    $('#st-feedback-viewer').show();
    loadFeedbackViewerContent();
    return;
  }

  const html = `
    <div id="st-feedback-viewer" style="
      position:fixed; top:50%; left:50%;
      transform:translate(-50%,-50%);
      width:85vw; max-width:700px; height:75vh;
      background:var(--SmartThemeBodyColor,#1a1a1a);
      border:1px solid var(--SmartThemeBorderColor,#555);
      border-radius:10px; z-index:99999;
      display:flex; flex-direction:column;
      box-shadow:0 8px 32px rgba(0,0,0,0.6);
    ">
      <div style="
        display:flex; justify-content:space-between; align-items:center;
        padding:12px 16px; border-bottom:1px solid var(--SmartThemeBorderColor,#555);
        flex-shrink:0;
      ">
        <span style="font-weight:bold;color:var(--SmartThemeBodyTextColor,#eee);font-size:14px;">
          📋 피드백 모아보기
        </span>
        <button id="st-feedback-viewer-close" style="
          background:none;border:none;
          color:var(--SmartThemeBodyTextColor,#eee);
          font-size:20px;cursor:pointer;
        ">✕</button>
      </div>
      <div id="st-feedback-viewer-body" style="
        flex:1; overflow-y:auto; padding:16px;
        color:var(--SmartThemeBodyTextColor,#eee);
        font-size:13px; line-height:1.7;
      ">
        <div id="st-feedback-viewer-content"></div>
      </div>
      <div style="
        display:flex; gap:8px; padding:12px 16px;
        border-top:1px solid var(--SmartThemeBorderColor,#555);
        flex-shrink:0;
      ">
        <button id="st-feedback-viewer-export" style="
          flex:1; padding:8px; border:none; border-radius:6px;
          background:var(--SmartThemeQuoteColor,#555);
          color:#fff; cursor:pointer; font-size:13px;
        ">💾 txt로 저장</button>
      </div>
    </div>
  `;

  $('body').append(html);

  $('#st-feedback-viewer-close').on('click', () => {
    $('#st-feedback-viewer').remove();
  });

  $('#st-feedback-viewer-export').on('click', () => {
    const chatId = getCurrentChatId();
    if (!chatId) { toastr.info("No chat selected."); return; }
    const result = buildFeedbackOnlyText(chatId, getContext().chat);
    if (!result) { toastr.info("피드백이 없습니다."); return; }
    downloadTxt(result.text, "피드백_" + safeName(chatId) + "_" + new Date().toISOString().slice(0, 10) + ".txt");
    toastr.success(result.count + "개 피드백 저장 완료!");
  });

  loadFeedbackViewerContent();
}

function loadFeedbackViewerContent() {
  const $content = $('#st-feedback-viewer-content');
  const chatId = getCurrentChatId();

  if (!chatId) {
    $content.html('<div style="opacity:0.6;text-align:center;padding:40px;">채팅방을 먼저 열어주세요.</div>');
    return;
  }

  const messages = getContext().chat;
  let count = 0;
  let html = '';

  messages.forEach((message, messageId) => {
    if (!message.is_user || !message.extra?.inputFeedback) return;
    count++;

    const msg = message.extra.inputFeedback.message || message.mes;
    const feedback = message.extra.inputFeedback.feedback;

    html += `
      <div style="
        margin-bottom:20px; padding:14px;
        background:var(--SmartThemeBlurTintColor,rgba(255,255,255,0.05));
        border-radius:8px; border-left:3px solid var(--SmartThemeQuoteColor,#888);
      ">
        <div style="font-size:11px;opacity:0.5;margin-bottom:6px;">#${count} · 메시지 ${messageId}</div>
        <div style="margin-bottom:8px;">
          <span style="opacity:0.6;font-size:11px;">✏️ 내 메시지</span><br>
          <span style="opacity:0.9;">${msg}</span>
        </div>
        <div>
          <span style="opacity:0.6;font-size:11px;">💬 피드백</span><br>
          <span style="opacity:0.85;white-space:pre-wrap;">${feedback}</span>
        </div>
      </div>
    `;
  });

  if (count === 0) {
    $content.html('<div style="opacity:0.6;text-align:center;padding:40px;">이 채팅에 저장된 피드백이 없습니다.</div>');
  } else {
    $content.html(`<div style="opacity:0.5;font-size:12px;margin-bottom:16px;">총 ${count}개 피드백</div>` + html);
  }
}

// ── Settings ──────────────────────────────────────────

async function loadSettings() {
  extension_settings[extensionName] = extension_settings[extensionName] || {};
  if (Object.keys(extension_settings[extensionName]).length === 0) {
    Object.assign(extension_settings[extensionName], defaultSettings);
  }
  for (const key of Object.keys(defaultSettings)) {
    if (extension_settings[extensionName][key] === undefined) {
      extension_settings[extensionName][key] = defaultSettings[key];
    }
  }

  const s = extension_settings[extensionName];
  $("#input-feedback-enabled").prop("checked", s.enabled).trigger("input");
  $("#input-feedback-auto-new").prop("checked", s.autoNew).trigger("input");
  $("#input-feedback-auto-edit").prop("checked", s.autoEdit).trigger("input");
  $("#input-feedback-folded").prop("checked", s.folded).trigger("input");
  $("#input-feedback-show-quick").prop("checked", s.showQuickButton).trigger("input");
  $("#input-feedback-quick-side").val(s.quickButtonSide || "left");
  $("#input-feedback-template").val(s.template).trigger("input");
  $("#input-feedback-prompt").val(s.prompt).trigger("input");
  $("#input-feedback-num-prev-msgs").val(s.numPrevMsgs).trigger("input");
  $("#input-feedback-num-prev-msgs_value").html(s.numPrevMsgs);
  $("#input-feedback-provider").val(s.provider || "st");
  updateProviderUI(s.provider || "st", s.model, s.customModel, s.useCustomModel);
  updateQuickButton();
}

// ── ST 내장 API 라우팅 ────────────────────────────────

async function callViaSTProxy(prompt, provider, model) {
  const chat_completion_source = SOURCE_MAP[provider];
  if (!chat_completion_source) throw new Error("알 수 없는 공급자: " + provider);

  const parameters = {
    model: model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    max_tokens: 1000,
    stream: false,
    chat_completion_source: chat_completion_source,
  };

  if (provider === "vertexai") {
    parameters.vertexai_auth_mode = "full";
  }

  const response = await fetch("/api/backends/chat-completions/generate", {
    method: "POST",
    headers: { ...getRequestHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(parameters),
  });

  if (!response.ok) {
    let errorMessage = `${response.status}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData?.error?.message || errorData?.message || response.statusText || errorMessage;
    } catch (e) {
      errorMessage = response.statusText || errorMessage;
    }
    throw new Error(`API 오류 (${errorMessage})`);
  }

  const data = await response.json();
  if (data.choices?.[0]) return data.choices[0].message?.content || data.choices[0].text || "";
  if (data.content?.[0]) return data.content[0].text || "";
  if (data.candidates?.[0]) return data.candidates[0].content?.parts?.[0]?.text || "";
  throw new Error("응답 파싱 실패: " + JSON.stringify(data));
}

// ── 피드백 생성 ───────────────────────────────────────

function getMessage(messageId) {
  return getContext().chat[messageId];
}

function getPreviousMessages(messageId, numPrevMsgs) {
  const previousMessages = [];
  for (let i = messageId - 1; i >= 0 && i >= messageId - numPrevMsgs; i--) {
    const message = getMessage(i);
    previousMessages.unshift(`${message.name}: ${message.mes}`);
  }
  return previousMessages.join("\n\n");
}

async function getFeedback(messageId) {
  const s = extension_settings[extensionName];
  const message = getMessage(messageId);
  if (typeof message.extra !== "object") message.extra = {};

  const previousMessages = getPreviousMessages(messageId, s.numPrevMsgs);
  const prompt = s.template
    .replace(/{{previousMessages}}/i, previousMessages ?? "None")
    .replace(/{{message}}/i, message.mes)
    .replace(/{{prompt}}/i, s.prompt);

  showLoading(messageId);
  let feedback;
  try {
    if (s.provider === "st") {
      feedback = await generateRaw(prompt, null, false, true);
    } else {
      const model = s.useCustomModel ? (s.customModel || s.model) : s.model;
      feedback = await callViaSTProxy(prompt, s.provider, model);
    }
  } catch (err) {
    hideLoading(messageId);
    toastr.error("피드백 생성 실패: " + err.message);
    console.error("[InputFeedback]", err);
    return;
  }
  hideLoading(messageId);

  message.extra.inputFeedback = { message: message.mes, feedback };
  saveChatDebounced();
  displayFeedback(messageId);
}

function deleteMessage(messageId) {
  const message = getMessage(messageId);
  delete message.extra.inputFeedback;
  saveChatDebounced();
  $(`.mes[mesid="${messageId}"] .mes_block .input-feedback.content`).remove();
}

function handleMessageEdited(messageId) {
  const s = extension_settings[extensionName];
  if (!s.enabled || !s.autoEdit) return;
  const message = getMessage(messageId);
  if (message?.is_user && message.extra?.inputFeedback && message.extra.inputFeedback.message !== message.mes) {
    getFeedback(messageId);
  }
}

function handleUserMessageRendered(messageId) {
  if (!extensionSettings.enabled) return;
  
  const message = getMessage(messageId);
  if (!message || !message.is_user) return;

  addFeedbackButton(messageId);
  if (extensionSettings.autoNew) getFeedback(messageId);
}

function handleChatChanged() {
  getContext().chat.forEach((message, messageId) => {
    if (message.is_user) {
      if (extensionSettings.enabled) addFeedbackButton(messageId);
      if (message.extra?.inputFeedback) displayFeedback(messageId);
    }
  });
}

// ── 설정 이벤트 ───────────────────────────────────────

function onEnabledInput(event) {
  extension_settings[extensionName].enabled = Boolean($(event.target).prop("checked"));
  saveSettingsDebounced();
  if (!extension_settings[extensionName].enabled) {
    $(".mes_feedback").remove();
  } else {
    handleChatChanged();
  }
  updateQuickButtonState();
}

function onAutoNewInput(event) {
  extension_settings[extensionName].autoNew = Boolean($(event.target).prop("checked"));
  saveSettingsDebounced();
}

function onAutoEditInput(event) {
  extension_settings[extensionName].autoEdit = Boolean($(event.target).prop("checked"));
  saveSettingsDebounced();
}

function onFoldedInput(event) {
  extension_settings[extensionName].folded = Boolean($(event.target).prop("checked"));
  saveSettingsDebounced();
}

function onShowQuickInput(event) {
  extension_settings[extensionName].showQuickButton = Boolean($(event.target).prop("checked"));
  saveSettingsDebounced();
  updateQuickButton();
}

function onQuickSideChange() {
  extension_settings[extensionName].quickButtonSide = $(this).val();
  saveSettingsDebounced();
  updateQuickButton();
}

function onTemplateInput() {
  extension_settings[extensionName].template = $(this).val();
  saveSettingsDebounced();
}

function onPromptInput() {
  extension_settings[extensionName].prompt = $(this).val();
  saveSettingsDebounced();
}

function onNumPrevMsgsInput() {
  extension_settings[extensionName].numPrevMsgs = Number($(this).val());
  $("#input-feedback-num-prev-msgs_value").html(extension_settings[extensionName].numPrevMsgs);
  saveSettingsDebounced();
}

function onProviderChange() {
  const provider = $(this).val();
  extension_settings[extensionName].provider = provider;
  extension_settings[extensionName].model = DEFAULT_MODELS[provider] || "";
  extension_settings[extensionName].useCustomModel = false;
  saveSettingsDebounced();
  updateProviderUI(provider, DEFAULT_MODELS[provider] || "", "", false);
}

function onModelSelectChange() {
  extension_settings[extensionName].model = $(this).val();
  extension_settings[extensionName].useCustomModel = false;
  saveSettingsDebounced();
}

function onCustomModelInput() {
  const val = $(this).val().trim();
  extension_settings[extensionName].customModel = val;
  extension_settings[extensionName].useCustomModel = val.length > 0;
  saveSettingsDebounced();
}

function onPurgeClick() {
  if (!getCurrentChatId()) { toastr.info("No chat selected."); return; }

  $("#input-feedback-confirm-popup").remove();
  $("body").append(`
    <div id="input-feedback-confirm-popup" style="
      position:fixed; top:50%; left:50%;
      transform:translate(-50%,-50%);
      background:var(--SmartThemeBodyColor,#1a1a1a);
      border:1px solid #ff4444;
      border-radius:10px;
      padding:20px 24px;
      z-index:999999;
      text-align:center;
      min-width:260px;
      box-shadow:0 4px 20px rgba(0,0,0,0.6);
    ">
      <div style="color:var(--SmartThemeBodyTextColor,#eee);font-size:15px;margin-bottom:16px;">
        ⚠️ 정말 삭제하시겠습니까?<br>
        <span style="font-size:12px;opacity:0.7;">이 채팅의 모든 피드백이 삭제됩니다.</span>
      </div>
      <div style="display:flex;gap:10px;justify-content:center;">
        <button id="input-feedback-confirm-yes" style="
          padding:8px 20px; border:none; border-radius:6px;
          background:#8b0000; color:#fff; cursor:pointer; font-size:14px;
        ">네, 삭제합니다</button>
        <button id="input-feedback-confirm-no" style="
          padding:8px 20px; border:none; border-radius:6px;
          background:var(--SmartThemeQuoteColor,#555); color:#fff; cursor:pointer; font-size:14px;
        ">아니오</button>
      </div>
    </div>
  `);

  $("#input-feedback-confirm-yes").on("click", function () {
    getContext().chat.forEach((message) => {
      if (message.extra?.inputFeedback) delete message.extra.inputFeedback;
    });
    saveChatDebounced();
    $(".input-feedback.content").remove();
    $("#input-feedback-confirm-popup").remove();
    toastr.success("피드백이 삭제되었습니다.");
  });

  $("#input-feedback-confirm-no").on("click", function () {
    $("#input-feedback-confirm-popup").remove();
  });
}

function updateProviderUI(provider, model, customModel, useCustomModel) {
  const isExternal = provider !== "st";
  $("#input-feedback-model-section").toggle(isExternal);
  if (!isExternal) return;

  const $sel = $("#input-feedback-model-select");
  $sel.empty();
  const models = PRESET_MODELS[provider] || [];
  models.forEach(m => $sel.append(`<option value="${m}">${m}</option>`));

  const currentModel = model || DEFAULT_MODELS[provider] || "";
  if (models.includes(currentModel)) {
    $sel.val(currentModel);
  } else if (models.length > 0) {
    $sel.val(models[0]);
    extension_settings[extensionName].model = models[0];
  }

  $("#input-feedback-custom-model").val(customModel || "");
}

// ── 파일 다운로드 유틸 ────────────────────────────────

function downloadTxt(content, filename) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── 파일 이름 정제 ────────────────────────────────────
function safeName(str) {
  return str.replace(/[\\/:*?"<>|]/g, "_").slice(0, 50);
}

// ── 피드백만 추출 ─────────────────────────────────────

function buildFeedbackOnlyText(chatLabel, messages) {
  const lines = ["=== 피드백 추출 ===", "채팅: " + chatLabel, "추출일시: " + new Date().toLocaleString(), ""];
  let count = 0;
  messages.forEach((message, messageId) => {
    if (message.is_user && message.extra?.inputFeedback) {
      count++;
      lines.push(`--- #${count} (메시지 ${messageId}) ---`);
      lines.push("[내 메시지]"); lines.push(message.extra.inputFeedback.message); lines.push("");
      lines.push("[피드백]"); lines.push(message.extra.inputFeedback.feedback); lines.push("");
    }
  });
  if (count === 0) return null;
  lines.push("=== 총 " + count + "개 피드백 ===");
  return { text: lines.join("\n"), count };
}

// ── UI 헬퍼 ──────────────────────────────────────────

function drawer(content, folded = true) {
  const direction = folded ? "down" : "up";
  return `
  <div class="inline-drawer input-feedback content">
    <div class="inline-drawer-toggle inline-drawer-header">
      <span>Input Feedback</span>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-${direction} ${direction}"></div>
    </div>
    <div class="inline-drawer-content" ${!folded ? 'style="display:block"' : ""}>
      ${messageFormatting(content)}
      <div class="menu_button fa-solid fa-trash-can input-feedback-delete-button" title="Delete feedback"></div>
    </div>
  </div>`;
}

function showLoading(messageId) {
  $(`.mes[mesid="${messageId}"] .mes_block`).append(`
  <div class="inline-drawer input-feedback loading-indicator">
    <div class="inline-drawer-header">
      <div class="inline-drawer-icon fa-solid fa-spell-check fa-beat-fade"></div>
    </div>
  </div>`);
  $(`.mes[mesid="${messageId}"] .mes_block .input-feedback.content`).hide();
}

function hideLoading(messageId) {
  $(`.mes[mesid="${messageId}"] .mes_block .loading-indicator`).remove();
  $(`.mes[mesid="${messageId}"] .mes_block .input-feedback.content`).show();
}

function displayFeedback(messageId) {
  const message = getMessage(messageId);
  const feedback = message?.extra?.inputFeedback?.feedback;
  const feedbackDiv = $(`.mes[mesid="${messageId}"] .mes_block .input-feedback.content`);
  if (feedbackDiv.length) {
    feedbackDiv.replaceWith(drawer(feedback, extensionSettings.folded));
  } else {
    $(`.mes[mesid="${messageId}"] .mes_block`).append(drawer(feedback, extensionSettings.folded));
  }
}

function addFeedbackButton(messageId) {
  const extraButtons = $(`.mes[mesid=${messageId}] .mes_block .extraMesButtons`);
  if (extraButtons.find(".mes_feedback").length) return;
  extraButtons.append(`<div title="피드백 요청" class="mes_feedback fa-solid fa-spell-check"></div>`);
}

// ── 초기화 ────────────────────────────────────────────

jQuery(async () => {
  const settingsHtml = await $.get(`${extensionFolderPath}/setting.html`);
  $("#extensions_settings").append(settingsHtml);

  $("#input-feedback-enabled").on("input", onEnabledInput);
  $("#input-feedback-auto-new").on("input", onAutoNewInput);
  $("#input-feedback-auto-edit").on("input", onAutoEditInput);
  $("#input-feedback-folded").on("input", onFoldedInput);
  $("#input-feedback-show-quick").on("input", onShowQuickInput);
  $("#input-feedback-quick-side").on("change", onQuickSideChange);
  $("#input-feedback-template").on("input", onTemplateInput);
  $("#input-feedback-prompt").on("input", onPromptInput);
  $("#input-feedback-num-prev-msgs").on("input", onNumPrevMsgsInput);
  $("#input-feedback-provider").on("change", onProviderChange);
  $("#input-feedback-model-select").on("change", onModelSelectChange);
  $("#input-feedback-custom-model").on("input", onCustomModelInput);
  $("#input-feedback-purge").on("click", onPurgeClick);
  $("#input-feedback-export").on("click", onExportClick);

  loadSettings();

  // 안전하게 초기화 완료 시점에 확장 메뉴에 피드백 뷰어 버튼을 추가합니다.
  if (!$('#st-feedback-viewer-menu-btn').length) {
    const $menu = $('#extensionsMenu');
    if ($menu.length) {
      $menu.append(`
        <div id="st-feedback-viewer-menu-btn" class="list-group-item interactable">
          <div class="list-group-item-action">
            <i class="fa-solid fa-spell-check"></i>
          </div>
          <div class="list-group-item-label">피드백 모아보기</div>
        </div>
      `);
      
      // 인라인 고장 유발 코드 지우고 안전하게 이벤트 바인딩 처리
      $('#st-feedback-viewer-menu-btn').on('click', () => {
        if (typeof createFeedbackViewer === 'function') createFeedbackViewer();
      });
    }
  }

  eventSource.on(event_types.MESSAGE_EDITED, handleMessageEdited);
  eventSource.on(event_types.USER_MESSAGE_RENDERED, handleUserMessageRendered);
  eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);
  eventSource.on(event_types.CHAT_CHANGED, updateQuickButton);

  $(document).on("click", ".mes_feedback", function () {
    if (!extensionSettings.enabled) return;
    getFeedback(Number($(this).closest(".mes").attr("mesid")));
  });

  $(document).on("click", ".input-feedback-delete-button", function () {
    if (!extensionSettings.enabled) return;
    deleteMessage(Number($(this).closest(".mes").attr("mesid")));
  });
});
