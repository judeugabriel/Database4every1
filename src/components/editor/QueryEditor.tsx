import { useEffect, useRef } from "react";
import Editor, { useMonaco, type Monaco, type OnMount } from "@monaco-editor/react";
import type { editor, Position } from "monaco-editor";
import type { CompletionCatalog } from "../../types/database";

interface QueryEditorProps {
  modelKey: string;
  language: "sql" | "json";
  query: string;
  completionCatalog: CompletionCatalog;
  onChange: (query: string) => void;
  onRun: () => void;
  onFocus: () => void;
}

export function QueryEditor({
  modelKey,
  language,
  query,
  completionCatalog,
  onChange,
  onRun,
  onFocus,
}: QueryEditorProps) {
  const monaco = useMonaco();
  const runRef = useRef(onRun);
  const focusRef = useRef(onFocus);
  const changeRef = useRef(onChange);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const queryRef = useRef(query);

  useEffect(() => {
    runRef.current = onRun;
  }, [onRun]);

  useEffect(() => {
    focusRef.current = onFocus;
  }, [onFocus]);

  useEffect(() => {
    changeRef.current = onChange;
  }, [onChange]);

  // `onChange` never updates the React `query` prop, so a prop change here is
  // necessarily a programmatic query rewrite (pagination/sort/limit), not a
  // keystroke echo. This keeps Monaco uncontrolled while showing the query that
  // is actually sent to the backend.
  useEffect(() => {
    if (query === queryRef.current) return;
    queryRef.current = query;
    const instance = editorRef.current;
    if (instance && instance.getValue() !== query) instance.setValue(query);
  }, [query]);

  useEffect(() => {
    if (!monaco) return;
    return registerCompletions(monaco, completionCatalog, modelKey);
  }, [monaco, completionCatalog, modelKey]);

  const handleMount: OnMount = (instance, editorMonaco) => {
    editorRef.current = instance;
    queryRef.current = instance.getValue();
    instance.updateOptions({
      readOnly: false,
      domReadOnly: false,
      contextmenu: true,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
    });
    const editorNode = instance.getDomNode();
    if (editorNode) {
      // pointerEvents is a DOM/CSS property, not a Monaco IEditorOption.
      editorNode.style.pointerEvents = "auto";
      editorNode.querySelector("textarea")?.removeAttribute("readonly");
      const focusEditor = () => {
        if (!instance.hasWidgetFocus()) instance.focus();
      };
      editorNode.addEventListener("click", focusEditor);
      instance.onDidDispose(() => editorNode.removeEventListener("click", focusEditor));
    }
    instance.addAction({
      id: `run-query-${modelKey}`,
      label: "Run Query",
      keybindings: [editorMonaco.KeyMod.CtrlCmd | editorMonaco.KeyCode.Enter],
      run: () => runRef.current(),
    });
    const runFromKeyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        runRef.current();
      }
    };
    editorNode?.addEventListener("keydown", runFromKeyboard, true);
    instance.onDidDispose(() => editorNode?.removeEventListener("keydown", runFromKeyboard, true));
    instance.onDidFocusEditorText(() => focusRef.current());
    instance.layout();
    const focusTimer = window.setTimeout(() => instance.focus(), 50);
    instance.onDidDispose(() => window.clearTimeout(focusTimer));
  };

  return (
    <div className="h-full w-full min-h-0 flex-1 overflow-hidden query-editor-container">
      <Editor
        key={modelKey}
        // One stable Monaco model per query tab. React never writes into this
        // model while the user is typing.
        path={modelKey}
        height="100%"
        width="100%"
        defaultLanguage={language}
        defaultValue={query}
        onChange={(value) => {
          const nextQuery = value ?? "";
          queryRef.current = nextQuery;
          changeRef.current(nextQuery);
        }}
        onMount={handleMount}
        beforeMount={configureMonaco}
        theme="datacraft-dark"
        options={{
          readOnly: false,
          domReadOnly: false,
          automaticLayout: true,
          contextmenu: true,
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          selectOnLineNumbers: true,
          scrollBeyondLastLine: false,
          wordWrap: "on",
          minimap: { enabled: false },
          fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
          fontSize: 13,
          lineHeight: 21,
          padding: { top: 14, bottom: 14 },
          renderLineHighlight: "gutter",
          smoothScrolling: true,
          suggest: { showKeywords: true, showFields: true },
        }}
      />
    </div>
  );
}

function configureMonaco(monaco: Monaco) {
  monaco.editor.defineTheme("datacraft-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword.sql", foreground: "C792EA", fontStyle: "bold" },
      { token: "string.sql", foreground: "C3E88D" },
      { token: "number.sql", foreground: "F78C6C" },
      { token: "comment.sql", foreground: "63707D", fontStyle: "italic" },
    ],
    colors: {
      "editor.background": "#11161D",
      "editor.foreground": "#D8DEE9",
      "editorLineNumber.foreground": "#47515E",
      "editorLineNumber.activeForeground": "#A9B4C0",
      "editorCursor.foreground": "#68D8B8",
      "editor.selectionBackground": "#294A5E88",
      "editor.lineHighlightBackground": "#171E27",
      "editorSuggestWidget.background": "#171E27",
      "editorSuggestWidget.border": "#303A46",
    },
  });
}

function registerCompletions(
  monaco: Monaco,
  catalog: CompletionCatalog,
  modelKey: string,
) {
  const provider = monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: [".", " "],
    provideCompletionItems(model: editor.ITextModel, position: Position) {
      if (!model.uri.path.includes(modelKey)) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const linePrefix = model
        .getLineContent(position.lineNumber)
        .slice(0, position.column - 1);
      const qualifier = linePrefix.match(/([\w.]+)\.$/)?.[1];
      const fieldSuggestions = catalog.fields
        .filter(
          (field) =>
            !qualifier || field.table === qualifier || field.table.endsWith(`.${qualifier}`),
        )
        .map((field) => ({
          label: field.name,
          kind: monaco.languages.CompletionItemKind.Field,
          detail: `${field.dataType} · ${field.table}`,
          insertText: field.name,
          sortText: `1-${field.name}`,
          range,
        }));
      const tableSuggestions = catalog.tables.map((table) => ({
        label: table,
        kind: monaco.languages.CompletionItemKind.Struct,
        detail: "Database object",
        insertText: table,
        sortText: `0-${table}`,
        range,
      }));
      return {
        suggestions: qualifier ? fieldSuggestions : [...tableSuggestions, ...fieldSuggestions],
      };
    },
  });
  return () => provider.dispose();
}
