'use strict';

/* App-owned chat page. Plain browser JavaScript; loaded after app.js. */
(() => {
  let instanceNumber = 0;

  const asText = (value) => {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  };

  const errorMessage = (error) => error?.message || asText(error) || 'Something went wrong.';

  window.createChatPage = function createChatPage({ root, notify }) {
    if (!root) throw new Error('Chat needs a root element.');

    const idPrefix = `chat-${++instanceNumber}`;
    const sends = new Map();
    const activities = new Map();
    const cache = new Map();
    const drafts = new Map();

    let disposed = false;
    let hasShown = false;
    let conversations = [];
    let activeId = null;
    let current = null;
    let navigationVersion = 0;
    let listLoading = false;
    let currentLoading = false;
    let operationBusy = false;
    let renaming = false;
    let listError = '';
    let problem = null;

    function node(tag, props = {}, ...children) {
      const element = document.createElement(tag);
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value);
        else if (key === 'class') element.className = value;
        else if (['hidden', 'disabled', 'value', 'open', 'checked'].includes(key)) element[key] = value;
        else element.setAttribute(key, value === true ? '' : String(value));
      }
      for (const child of children.flat()) {
        if (child === undefined || child === null || child === false) continue;
        element.append(child.nodeType ? child : document.createTextNode(String(child)));
      }
      return element;
    }

    const spinner = () => node('span', { class: 'chat-spinner', 'aria-hidden': 'true' });
    const subtitle = (text) => node('span', { class: 'chat-muted' }, text);

    function emit() {
      if (typeof notify !== 'function') return;
      try {
        const summary = conversations.find((conversation) => conversation.id === activeId);
        notify({ busy: sends.size > 0, title: current?.title || summary?.title });
      } catch {
        /* Host notifications must never break chat. */
      }
    }

    function sortConversations() {
      conversations.sort((a, b) => {
        const aTime = Date.parse(a.updatedAt || a.createdAt || '') || 0;
        const bTime = Date.parse(b.updatedAt || b.createdAt || '') || 0;
        return bTime - aTime;
      });
    }

    function summaryFor(conversation) {
      const previous = conversations.find((item) => item.id === conversation.id) || cache.get(conversation.id);
      return {
        id: conversation.id,
        title: conversation.title || 'New chat',
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messageCount: Array.isArray(conversation.messages)
          ? conversation.messages.length
          : conversation.messageCount ?? previous?.messageCount ?? 0,
      };
    }

    function upsertConversation(conversation) {
      if (!conversation?.id) return;
      cache.set(conversation.id, conversation);
      const summary = summaryFor(conversation);
      const index = conversations.findIndex((item) => item.id === conversation.id);
      if (index === -1) conversations.push(summary);
      else conversations[index] = { ...conversations[index], ...summary };
      sortConversations();
    }

    function headers(method, stream = false) {
      return {
        Accept: stream ? 'text/event-stream' : 'application/json',
        'Content-Type': 'application/json',
        'X-Requested-With': 'd365fo-ui',
      };
    }

    async function request(path, method = 'GET', body, signal) {
      let response;
      try {
        response = await fetch(path, {
          method,
          headers: headers(method),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        throw new Error('The app could not be reached. Check that it is still running, then try again.');
      }
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const message = data?.error?.message || data?.error || data?.message || `Request failed (${response.status}).`;
        throw new Error(asText(message));
      }
      return data;
    }

    async function streamRequest(path, body, signal, onEvent) {
      let response;
      try {
        response = await fetch(path, {
          method: 'POST',
          headers: headers('POST', true),
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        throw new Error('The app could not be reached. Check that it is still running, then try again.');
      }

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        const message = data?.error?.message || data?.error || data?.message || `Request failed (${response.status}).`;
        throw new Error(asText(message));
      }
      if (!response.body) throw new Error('This browser cannot read the chat response stream.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      function consume(block) {
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data.trim()) return;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          throw new Error('The chat response was not valid. Refresh the conversation and try again.');
        }
        onEvent(event);
      }

      function drain(final = false) {
        const separator = /\r?\n\r?\n/g;
        let match;
        while ((match = separator.exec(buffer))) {
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(separator.lastIndex);
          separator.lastIndex = 0;
          consume(block);
        }
        if (final && buffer.trim()) {
          consume(buffer);
          buffer = '';
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          drain();
        }
        buffer += decoder.decode();
        drain(true);
      } catch (error) {
        try {
          await reader.cancel();
        } catch {
          /* The original stream error is more useful to the user. */
        }
        throw error;
      } finally {
        reader.releaseLock();
      }
    }

    const page = node('section', { class: 'chat-page', 'aria-label': 'Chat' });
    const history = node('div', { class: 'chat-history', role: 'list', 'aria-label': 'Chat conversations' });
    const newButton = node(
      'button',
      { class: 'primary chat-new-button', type: 'button', onclick: () => void newChat() },
      node('span', { 'aria-hidden': 'true' }, '+'),
      ' New chat',
    );
    const refreshButton = node('button', {
      class: 'ghost icon chat-refresh-button',
      type: 'button',
      'aria-label': 'Refresh conversations',
      title: 'Refresh conversations',
      onclick: () => void reload(false),
    }, '↻');

    const conversationHead = node('div', { class: 'chat-conversation-head' });
    const errorBox = node('div', { class: 'chat-error', hidden: true, role: 'alert' });
    const messages = node('div', {
      class: 'chat-messages',
      role: 'log',
      'aria-live': 'polite',
      'aria-relevant': 'additions text',
      'aria-label': 'Conversation messages',
      tabindex: '0',
    });

    const composerId = `${idPrefix}-composer`;
    const textarea = node('textarea', {
      id: composerId,
      class: 'chat-composer-input',
      rows: '3',
      placeholder: 'Ask about setup, a test case, or a result…',
      'aria-describedby': `${idPrefix}-composer-help`,
    });
    const sendButton = node('button', { class: 'primary chat-send', type: 'submit' }, 'Send');
    const stopButton = node('button', {
      class: 'danger chat-stop',
      type: 'button',
      hidden: true,
      onclick: () => void cancelActiveSend(),
    }, 'Stop');
    const composer = node(
      'form',
      { class: 'chat-composer', onsubmit: (event) => {
        event.preventDefault();
        void sendMessage();
      } },
      node('label', { class: 'chat-sr-only', for: composerId }, 'Message'),
      textarea,
      node(
        'div',
        { class: 'chat-composer-foot' },
        node('span', { class: 'chat-composer-help', id: `${idPrefix}-composer-help` }, 'Enter to send · Shift+Enter for a new line'),
        node('div', { class: 'chat-composer-actions' }, stopButton, sendButton),
      ),
    );

    const sidebar = node(
      'aside',
      { class: 'chat-sidebar', 'aria-label': 'Conversation history' },
      node(
        'div',
        { class: 'chat-sidebar-head' },
        node('h2', {}, 'Conversations'),
        refreshButton,
      ),
      node('div', { class: 'chat-sidebar-new' }, newButton),
      history,
    );
    const main = node(
      'section',
      { class: 'chat-main', 'aria-label': 'Current conversation' },
      conversationHead,
      errorBox,
      messages,
      composer,
    );
    page.append(
      node(
        'div',
        { class: 'chat-page-head' },
        node('div', {}, node('h1', {}, 'Chat'), node('p', { class: 'chat-muted' }, 'Ask for help with your environment, tests, and results.')),
      ),
      node('div', { class: 'chat-layout' }, sidebar, main),
    );
    root.replaceChildren(page);
    root.hidden = true;

    function autoSizeComposer() {
      textarea.style.height = 'auto';
      if (textarea.value) textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
    }

    function restoreDraft(id) {
      textarea.value = drafts.get(id) || '';
      autoSizeComposer();
    }

    textarea.addEventListener('input', () => {
      if (activeId) drafts.set(activeId, textarea.value);
      autoSizeComposer();
      syncComposer();
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (!event.repeat && !sends.has(activeId)) void sendMessage();
    });

    function formatWhen(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      const now = new Date();
      const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (date.toDateString() === now.toDateString()) return time;
      return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} · ${time}`;
    }

    function messageCount(count) {
      const number = Number(count) || 0;
      return `${number} message${number === 1 ? '' : 's'}`;
    }

    function renderHistory() {
      newButton.disabled = operationBusy;
      refreshButton.disabled = operationBusy || listLoading;
      if (listLoading && !conversations.length) {
        history.replaceChildren(node('div', { class: 'chat-sidebar-empty' }, spinner(), ' Loading conversations…'));
        return;
      }
      const children = conversations.map((conversation) => {
        const active = conversation.id === activeId;
        const sending = sends.has(conversation.id);
        const facts = [messageCount(conversation.messageCount), formatWhen(conversation.updatedAt || conversation.createdAt)].filter(Boolean).join(' · ');
        const selector = node(
          'button',
          {
            class: `chat-history-select${active ? ' active' : ''}`,
            type: 'button',
            'aria-current': active ? 'true' : undefined,
            'aria-label': `Open ${conversation.title || 'New chat'}`,
            title: conversation.title || 'New chat',
            disabled: operationBusy,
            onclick: () => void selectConversation(conversation.id),
          },
          node(
            'span',
            { class: 'chat-history-top' },
            node('span', { class: 'chat-history-title' }, conversation.title || 'New chat'),
            sending ? spinner() : null,
          ),
          node(
            'span',
            { class: 'chat-history-meta' },
            node('span', {}, facts || 'No messages yet'),
          ),
        );
        return node('div', { class: 'chat-history-item', role: 'listitem' }, selector);
      });
      if (!conversations.length && !listLoading) {
        children.length = 0;
        children.push(node('div', { class: 'chat-sidebar-empty' }, listError ? 'Conversations are unavailable.' : 'No conversations yet.'));
      }
      if (listError) {
        children.push(node(
          'div',
          { class: 'chat-list-error' },
          node('p', {}, listError),
          node('button', { type: 'button', class: 'chat-small-button', onclick: () => void reload(false) }, 'Try again'),
        ));
      }
      if (listLoading && conversations.length) children.unshift(node('div', { class: 'chat-list-loading' }, spinner(), ' Refreshing…'));
      history.replaceChildren(...children);
    }

    function startRename() {
      if (!current || operationBusy || sends.has(activeId)) return;
      renaming = true;
      problem = null;
      renderAll();
      const input = conversationHead.querySelector('input');
      if (input) {
        input.focus();
        input.select();
      }
    }

    function renderHeader() {
      const summary = conversations.find((conversation) => conversation.id === activeId);
      const displayed = current || summary;
      if (!displayed) {
        conversationHead.replaceChildren(node('div', { class: 'chat-heading-wrap' }, node('h2', {}, 'Welcome'), subtitle('A guided place to work with D365FO Agent')));
        return;
      }
      if (renaming && current) {
        const inputId = `${idPrefix}-rename`;
        const input = node('input', {
          id: inputId,
          class: 'chat-rename-input',
          value: current.title || '',
          maxlength: '200',
          required: true,
          'aria-label': 'Conversation title',
        });
        const form = node(
          'form',
          { class: 'chat-rename-form', onsubmit: (event) => {
            event.preventDefault();
            void saveRename(input.value);
          } },
          node('label', { class: 'chat-sr-only', for: inputId }, 'Conversation title'),
          input,
          node('button', { class: 'primary', type: 'submit', disabled: operationBusy }, 'Save'),
          node('button', { type: 'button', class: 'ghost', disabled: operationBusy, onclick: () => {
            renaming = false;
            renderAll();
          } }, 'Cancel'),
        );
        input.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          renaming = false;
          renderAll();
        });
        conversationHead.replaceChildren(form);
        return;
      }
      const sending = sends.has(activeId);
      conversationHead.replaceChildren(
        node(
          'div',
          { class: 'chat-heading-wrap' },
          node('h2', { title: displayed.title || 'New chat' }, displayed.title || 'New chat'),
          sending ? node('span', { class: 'chat-heading-status' }, spinner(), sending.cancelling ? 'Stopping…' : 'Working…') : null,
        ),
        node(
          'div',
          { class: 'chat-conversation-actions' },
          node('button', {
            type: 'button',
            class: 'ghost chat-small-button',
            disabled: operationBusy || sending || currentLoading,
            onclick: startRename,
          }, 'Rename'),
          node('button', {
            type: 'button',
            class: 'ghost danger chat-small-button',
            disabled: operationBusy || sending || currentLoading,
            onclick: () => void deleteCurrent(),
          }, 'Delete'),
        ),
      );
    }

    function renderProblem() {
      errorBox.hidden = !problem;
      errorBox.replaceChildren();
      if (!problem) return;
      errorBox.append(
        node('p', {}, problem.message),
        node(
          'div',
          { class: 'chat-error-actions' },
          problem.retry ? node('button', {
            type: 'button',
            class: 'chat-small-button',
            onclick: () => void problem.retry(),
          }, 'Refresh conversation') : null,
          node('button', { type: 'button', class: 'ghost chat-small-button', onclick: () => {
            problem = null;
            renderProblem();
          } }, 'Dismiss'),
        ),
      );
    }

    function navigate(tab) {
      root.dispatchEvent(new CustomEvent('d365fo:navigate', { bubbles: true, detail: { tab } }));
      if (typeof window.showTab === 'function') {
        try {
          void window.showTab(tab);
        } catch {
          /* The host may implement navigation through the event instead. */
        }
      }
    }

    function welcomeAction(title, description, button, tab) {
      return node(
        'div',
        { class: 'chat-welcome-card' },
        node('h3', {}, title),
        node('p', {}, description),
        node('button', { type: 'button', class: 'chat-small-button', onclick: () => navigate(tab) }, button),
      );
    }

    function renderWelcome() {
      return node(
        'div',
        { class: 'chat-welcome' },
        node('div', { class: 'chat-welcome-mark', 'aria-hidden': 'true' }, '✦'),
        node('h2', {}, 'How can I help?'),
        node('p', {}, 'Start a chat to configure D365FO Agent, understand a test, or investigate a result.'),
        node('button', { type: 'button', class: 'primary chat-start-button', disabled: operationBusy, onclick: () => void newChat() }, 'Start a chat'),
        node(
          'div',
          { class: 'chat-welcome-grid' },
          welcomeAction('1. Set up', 'Connect your AI model and configure a Finance & Operations sandbox in Settings.', 'Open Settings', 'settings'),
          welcomeAction('2. Test', 'Load or create test cases, select the steps to validate, and run them in your environment.', 'Open Tests', 'cases'),
          welcomeAction('3. Review results', 'Inspect each run, its outcome, and the evidence captured along the way.', 'Open Results', 'results'),
        ),
      );
    }

    function toolCallDetails(calls) {
      if (!Array.isArray(calls) || !calls.length) return null;
      return node(
        'details',
        { class: 'chat-historical-tools' },
        node('summary', {}, `${calls.length} tool call${calls.length === 1 ? '' : 's'}`),
        ...calls.map((call) => node(
          'div',
          { class: 'chat-historical-tool' },
          node('strong', {}, call?.name || 'Tool'),
          call?.arguments && Object.keys(call.arguments).length ? node('pre', {}, asText(call.arguments)) : null,
        )),
      );
    }

    function messageNode(message) {
      const mine = message.role === 'user';
      return node(
        'article',
        { class: `chat-message ${mine ? 'chat-user' : 'chat-assistant'}`, 'aria-label': mine ? 'Your message' : 'Assistant message' },
        node(
          'div',
          { class: 'chat-message-meta' },
          node('strong', {}, mine ? 'You' : 'Assistant'),
          formatWhen(message.at) ? node('time', { datetime: message.at || '' }, formatWhen(message.at)) : null,
        ),
        mine || !window.chatMarkdown
          ? node('div', { class: 'chat-message-content' }, asText(message.content))
          : node('div', { class: 'chat-message-content chat-markdown' }, ...window.chatMarkdown.renderMarkdown(asText(message.content), node)),
        !mine ? toolCallDetails(message.toolCalls) : null,
      );
    }

    function historicalToolNodes(toolMessages) {
      return node(
        'details',
        { class: 'chat-tool-history' },
        node('summary', {}, `${toolMessages.length} tool ${toolMessages.length === 1 ? 'activity' : 'activities'}`),
        ...toolMessages.map((message, index) => node(
          'div',
          { class: 'chat-historical-tool' },
          node('strong', {}, message.toolName || `Tool ${index + 1}`),
          message.content ? node('pre', {}, asText(message.content)) : null,
        )),
      );
    }

    function activityNode(activity, live) {
      if (!activity || (!live && !activity.tools.length && !activity.status)) return null;
      const running = activity.tools.filter((tool) => tool.status === 'running').length;
      const label = live ? 'Assistant activity' : 'Latest assistant activity';
      return node(
        'details',
        { class: 'chat-activity', open: live },
        node('summary', {}, live ? node('span', { class: 'chat-activity-summary' }, spinner(), label) : `${label}${activity.tools.length ? ` · ${activity.tools.length}` : ''}`),
        activity.status ? node('p', { class: 'chat-live-status', role: 'status' }, activity.status) : null,
        running && !activity.status ? node('p', { class: 'chat-live-status', role: 'status' }, `${running} tool${running === 1 ? '' : 's'} running…`) : null,
        activity.tools.length ? node(
          'div',
          { class: 'chat-activity-tools' },
          ...activity.tools.map((tool) => node(
            'div',
            { class: `chat-activity-tool chat-tool-${tool.status}` },
            node('span', { class: 'chat-tool-icon', 'aria-hidden': 'true' }, tool.status === 'running' ? spinner() : tool.status === 'failed' ? '✕' : '✓'),
            node(
              'div',
              { class: 'chat-activity-tool-copy' },
              node('strong', {}, tool.name),
              node('span', { class: 'chat-muted' }, tool.status === 'running' ? 'Running' : tool.status === 'failed' ? 'Failed' : 'Finished'),
              tool.detail ? node('div', { class: 'chat-tool-detail' }, asText(tool.detail)) : null,
            ),
          )),
        ) : null,
      );
    }

    function renderMessages() {
      const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
      if (!activeId && !current) {
        messages.replaceChildren(renderWelcome());
        return;
      }
      if (currentLoading && !current) {
        messages.replaceChildren(node('div', { class: 'chat-loading' }, spinner(), ' Loading conversation…'));
        return;
      }
      if (!current) {
        messages.replaceChildren();
        return;
      }

      const visibleMessages = Array.isArray(current.messages) ? current.messages : [];
      const children = [];
      let toolBuffer = [];
      const flushTools = () => {
        if (!toolBuffer.length) return;
        children.push(historicalToolNodes(toolBuffer));
        toolBuffer = [];
      };
      for (const message of visibleMessages) {
        if (message.role === 'tool') {
          toolBuffer.push(message);
          continue;
        }
        if (message.role !== 'user' && message.role !== 'assistant') continue;
        flushTools();
        children.push(messageNode(message));
      }
      flushTools();

      const live = sends.get(activeId);
      if (live && !live.receivedConversation) {
        children.push(messageNode({ role: 'user', content: live.text, at: live.startedAt }));
      }
      const activity = live || activities.get(activeId);
      const activityElement = activityNode(activity, Boolean(live));
      if (activityElement) children.push(activityElement);

      if (!children.length) {
        children.push(node(
          'div',
          { class: 'chat-no-messages' },
          node('strong', {}, 'Start the conversation'),
          node('p', {}, 'Ask for help setting up an environment, writing a test case, or understanding a result.'),
        ));
      }
      messages.replaceChildren(...children);
      if (nearBottom || live || !messages.scrollTop) messages.scrollTop = messages.scrollHeight;
    }

    function syncComposer() {
      const live = sends.get(activeId);
      composer.hidden = !current;
      textarea.disabled = !current || currentLoading || operationBusy || renaming;
      sendButton.hidden = Boolean(live);
      sendButton.disabled = !current || currentLoading || operationBusy || renaming || Boolean(live) || !textarea.value.trim();
      stopButton.hidden = !live;
      stopButton.disabled = !live || live.cancelling;
      stopButton.textContent = live?.cancelling ? 'Stopping…' : 'Stop';
    }

    function renderAll() {
      if (disposed) return;
      renderHistory();
      renderHeader();
      renderProblem();
      renderMessages();
      syncComposer();
    }

    async function openInto(id, version, selectionChanged) {
      activeId = id;
      current = cache.get(id) || null;
      currentLoading = true;
      problem = null;
      renaming = false;
      renderAll();
      if (selectionChanged) {
        restoreDraft(id);
        emit();
      }
      try {
        const conversation = await request(`/api/chat/conversations/${encodeURIComponent(id)}`);
        if (disposed || version !== navigationVersion) return;
        if (!conversation?.id) throw new Error('The app returned an invalid conversation.');
        current = conversation;
        activeId = conversation.id;
        upsertConversation(conversation);
        currentLoading = false;
        renderAll();
      } catch (error) {
        if (disposed || version !== navigationVersion) return;
        currentLoading = false;
        problem = { message: errorMessage(error), retry: () => reload(false) };
        renderAll();
      }
    }

    async function reload(openNewest) {
      if (disposed || operationBusy) return;
      const version = ++navigationVersion;
      listLoading = true;
      currentLoading = Boolean(activeId);
      listError = '';
      renderAll();
      try {
        const data = await request('/api/chat/conversations');
        if (disposed || version !== navigationVersion) return;
        conversations = Array.isArray(data?.conversations) ? data.conversations.filter((item) => item?.id) : [];
        sortConversations();
        listLoading = false;
        const previous = activeId;
        let target = null;
        if (openNewest) target = conversations[0]?.id || null;
        else target = conversations.some((item) => item.id === activeId) ? activeId : conversations[0]?.id || null;
        if (!target) {
          activeId = null;
          current = null;
          currentLoading = false;
          renaming = false;
          renderAll();
          if (previous) emit();
          return;
        }
        await openInto(target, version, target !== previous || !current);
      } catch (error) {
        if (disposed || version !== navigationVersion) return;
        listLoading = false;
        currentLoading = false;
        listError = errorMessage(error);
        renderAll();
      }
    }

    async function selectConversation(id) {
      if (disposed || operationBusy || id === activeId && current && !problem) return;
      if (activeId && textarea.value) drafts.set(activeId, textarea.value);
      const version = ++navigationVersion;
      listError = '';
      await openInto(id, version, true);
      if (!disposed && activeId === id) textarea.focus();
    }

    async function newChat() {
      if (disposed || operationBusy) return;
      const version = ++navigationVersion;
      operationBusy = true;
      listLoading = false;
      problem = null;
      renaming = false;
      renderAll();
      try {
        const conversation = await request('/api/chat/conversations', 'POST', {});
        if (disposed || version !== navigationVersion) return;
        if (!conversation?.id) throw new Error('The app returned an invalid conversation.');
        upsertConversation(conversation);
        activeId = conversation.id;
        current = conversation;
        currentLoading = false;
        activities.delete(conversation.id);
        operationBusy = false;
        renderAll();
        restoreDraft(conversation.id);
        emit();
        textarea.focus();
      } catch (error) {
        if (disposed || version !== navigationVersion) return;
        operationBusy = false;
        problem = { message: errorMessage(error), retry: () => reload(false) };
        renderAll();
      }
    }

    async function saveRename(value) {
      if (!current || operationBusy) return;
      const title = value.trim();
      if (!title) {
        problem = { message: 'Enter a conversation title.' };
        renderProblem();
        conversationHead.querySelector('input')?.focus();
        return;
      }
      if (title === current.title) {
        renaming = false;
        renderAll();
        return;
      }
      const id = current.id;
      operationBusy = true;
      problem = null;
      renderAll();
      try {
        const conversation = await request(`/api/chat/conversations/${encodeURIComponent(id)}`, 'PATCH', { title });
        if (disposed || activeId !== id) return;
        current = conversation;
        upsertConversation(conversation);
        renaming = false;
        operationBusy = false;
        renderAll();
        emit();
      } catch (error) {
        if (disposed) return;
        operationBusy = false;
        problem = { message: errorMessage(error) };
        renaming = false;
        renderAll();
      }
    }

    async function deleteCurrent() {
      if (!current || operationBusy || sends.has(activeId)) return;
      const id = current.id;
      const title = current.title || 'New chat';
      if (!window.confirm(`Delete “${title}”? This conversation and its messages will be removed.`)) return;
      const version = ++navigationVersion;
      operationBusy = true;
      problem = null;
      listLoading = false;
      renderAll();
      try {
        await request(`/api/chat/conversations/${encodeURIComponent(id)}`, 'DELETE');
        if (disposed || version !== navigationVersion) return;
        conversations = conversations.filter((conversation) => conversation.id !== id);
        cache.delete(id);
        drafts.delete(id);
        activities.delete(id);
        const next = conversations[0]?.id || null;
        if (!next) {
          activeId = null;
          current = null;
          currentLoading = false;
          operationBusy = false;
          renaming = false;
          renderAll();
          emit();
          return;
        }
        await openInto(next, version, true);
        if (disposed || version !== navigationVersion) return;
        operationBusy = false;
        renderAll();
      } catch (error) {
        if (disposed || version !== navigationVersion) return;
        operationBusy = false;
        problem = { message: errorMessage(error) };
        renderAll();
      }
    }

    function applyConversation(id, send, conversation) {
      if (!conversation?.id || conversation.id !== id) return;
      cache.set(id, conversation);
      upsertConversation(conversation);
      send.receivedConversation = true;
      if (activeId === id) {
        current = conversation;
        currentLoading = false;
      }
      renderHistory();
      if (activeId === id) {
        renderHeader();
        renderMessages();
      }
    }

    function onStreamEvent(id, send, event) {
      if (!event || sends.get(id) !== send) return;
      if (event.type === 'status') {
        send.status = asText(event.text);
      } else if (event.type === 'tool') {
        const name = asText(event.name) || 'Tool';
        let tool = null;
        if (event.status !== 'running') {
          for (let index = send.tools.length - 1; index >= 0; index--) {
            if (send.tools[index].name === name && send.tools[index].status === 'running') {
              tool = send.tools[index];
              break;
            }
          }
        }
        if (!tool) {
          tool = { name, status: 'running', detail: '' };
          send.tools.push(tool);
        }
        tool.status = ['running', 'finished', 'failed'].includes(event.status) ? event.status : 'finished';
        tool.detail = asText(event.detail);
      } else if (event.type === 'message' || event.type === 'done') {
        applyConversation(id, send, event.conversation);
        if (event.type === 'done') {
          send.done = true;
          send.status = '';
        }
        return;
      } else if (event.type === 'error') {
        throw new Error(asText(event.message) || 'The assistant could not complete the response.');
      } else {
        return;
      }
      if (activeId === id) {
        renderHeader();
        renderMessages();
        syncComposer();
      }
    }

    async function reconcile(id) {
      try {
        const conversation = await request(`/api/chat/conversations/${encodeURIComponent(id)}`);
        if (disposed || !conversation?.id) return;
        upsertConversation(conversation);
        if (activeId === id) current = conversation;
        renderAll();
      } catch {
        /* The actionable stream error stays visible; the user can retry the refresh. */
      }
    }

    async function sendMessage() {
      if (disposed || operationBusy || currentLoading || renaming || !current || sends.has(activeId)) return;
      const text = textarea.value.trim();
      if (!text) return;
      const id = current.id;
      const send = {
        controller: new AbortController(),
        text,
        startedAt: new Date().toISOString(),
        status: 'Connecting…',
        tools: [],
        receivedConversation: false,
        done: false,
        cancelling: false,
      };
      sends.set(id, send);
      activities.delete(id);
      drafts.delete(id);
      textarea.value = '';
      autoSizeComposer();
      problem = null;
      renderAll();
      emit();
      let streamError = null;
      try {
        await streamRequest(
          `/api/chat/conversations/${encodeURIComponent(id)}/messages`,
          { text },
          send.controller.signal,
          (event) => onStreamEvent(id, send, event),
        );
        if (!send.done && !send.cancelling) {
          throw new Error('The response ended before completion. Refresh the conversation before trying again.');
        }
      } catch (error) {
        if (send.cancelling) {
          send.status = 'Stopped.';
        } else if (!disposed) {
          streamError = error;
          send.status = '';
          problem = { message: errorMessage(error), retry: () => reload(false) };
        }
      } finally {
        if (sends.get(id) === send) sends.delete(id);
        if (!disposed && (send.tools.length || send.status)) activities.set(id, send);
        if (!disposed) {
          renderAll();
          emit();
        }
      }
      if (!disposed && (!send.done || streamError || send.cancelling)) await reconcile(id);
    }

    async function cancelActiveSend() {
      const id = activeId;
      const send = sends.get(id);
      if (!send || send.cancelling) return;
      send.cancelling = true;
      send.status = 'Stopping…';
      for (const tool of send.tools) if (tool.status === 'running') tool.status = 'failed';
      renderAll();
      let cancelError = null;
      try {
        await request(`/api/chat/conversations/${encodeURIComponent(id)}/cancel`, 'POST', {});
      } catch (error) {
        cancelError = error;
      } finally {
        send.controller.abort();
      }
      if (!disposed && cancelError) {
        problem = {
          message: `Stopped locally, but the server could not confirm cancellation: ${errorMessage(cancelError)}`,
          retry: () => reload(false),
        };
        renderProblem();
      }
    }

    async function show() {
      if (disposed) return;
      root.hidden = false;
      const firstShow = !hasShown;
      hasShown = true;
      await reload(firstShow);
    }

    function hide() {
      if (disposed) return;
      root.hidden = true;
    }

    async function refresh() {
      await reload(false);
    }

    function close() {
      if (disposed) return;
      disposed = true;
      navigationVersion++;
      for (const send of sends.values()) {
        send.cancelling = true;
        send.controller.abort();
      }
      sends.clear();
      activities.clear();
      cache.clear();
      drafts.clear();
      root.hidden = true;
      root.replaceChildren();
      if (typeof notify === 'function') {
        try {
          notify({ busy: false });
        } catch {
          /* Ignore host teardown errors. */
        }
      }
    }

    renderAll();
    return { show, hide, refresh, close };
  };
})();
