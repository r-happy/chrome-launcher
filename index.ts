// @ts-ignore
import Fuse from "fuse.js";

// ランチャーに表示したいサイトのリスト（すぐに表示できるプリセット）
const sites: SiteItem[] = [];

// サイトの型定義
type SiteItem = {
    name: string;
    url: string;
    type: "preset" | "bookmark" | "history" | "tab";
    favicon?: string;
    tabId?: number; // タブIDを追加
    isCurrentTab?: boolean; // 現在のタブかどうか
};

// 全てのサイト情報を格納する配列
let allSites: SiteItem[] = [...sites];
let filteredSites: SiteItem[] = [...sites];
let selectedIndex = 0;
let fuse: any = null;
let isDataLoaded = false;
let pendingSearch = "";
let isHistoryEnabled = true; // 履歴表示の有効/無効フラグ

// Fuse.jsの設定
const fuseOptions = {
    keys: [
        { name: "name", weight: 0.3 },
        { name: "url", weight: 0.7 },
    ],
    threshold: 0.8, // より寛容にマッチング
    distance: 100,
    includeScore: true,
};

// パフォーマンス最適化: DocumentFragmentを使用してDOM操作を高速化
let documentFragment: DocumentFragment;

// HTML要素を取得
const linksContainer = document.getElementById("links");
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const previewContainer = document.getElementById("preview") as HTMLElement;
const historyToggleButton = document.getElementById(
    "history-toggle"
) as HTMLButtonElement;

/**
 * 渡されたサイトのリストに基づいてリンクを描画する関数
 * @param sitesToRender 表示するサイトの配列
 */
function renderLinks(sitesToRender: SiteItem[]) {
    filteredSites = sitesToRender;
    selectedIndex = 0;

    // DocumentFragmentを使用してDOM操作を高速化
    documentFragment = document.createDocumentFragment();

    // 既存のリンクをクリア
    if (linksContainer) {
        linksContainer.innerHTML = "";
    }

    // バッチ処理でDOMを構築
    sitesToRender.forEach((site, index) => {
        const linkElement = createLinkElement(site, index);
        documentFragment.appendChild(linkElement);
    });

    // 一括でDOMに追加
    linksContainer?.appendChild(documentFragment);

    updateSelection();
    updatePreview();
}

// 検索ボックスに入力があったときのイベントリスナー（デバウンス機能付き）
let searchTimeout: number;
searchInput.addEventListener("input", () => {
    const searchTerm = searchInput.value.trim();

    // デバウンス処理で検索パフォーマンスを向上
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        performSearch(searchTerm);
    }, 150) as unknown as number;
});

/**
 * 検索実行関数（分離してパフォーマンス向上）
 */
function performSearch(searchTerm: string) {
    if (!searchTerm) {
        // 検索語が空の場合は現在のタブを優先表示
        const initialDisplay = getInitialDisplay();
        renderLinks(initialDisplay);
        return;
    }

    // データがまだロードされていない場合は、プリセットのみで検索
    const searchData = isDataLoaded ? allSites : sites;

    // Fuse.jsを使ったあいまい検索でサイトをフィルタリング
    const searchResults = fuzzySearchWithFuse(searchTerm, searchData);

    // 検索結果がない場合はWeb検索オプションを追加
    let resultsWithFallback = searchResults;
    if (searchResults.length === 0) {
        resultsWithFallback = [createWebSearchItem(searchTerm)];
    } else {
        // 検索結果があってもWeb検索オプションを最後に追加
        resultsWithFallback = [
            ...searchResults.slice(0, 49),
            createWebSearchItem(searchTerm),
        ];
    }

    // パフォーマンスのため、表示は最大50件に制限
    const limitedResults = resultsWithFallback.slice(0, 50);

    // フィルタリングされた結果でリンクを再描画
    renderLinks(limitedResults);

    // データがまだロードされていない場合は、保留中の検索として記録
    if (!isDataLoaded) {
        pendingSearch = searchTerm;
    }
}

/**
 * ブックマークを取得してallSitesに追加する関数
 */
async function loadBookmarks() {
    try {
        const bookmarkTree = await chrome.bookmarks.getTree();
        const bookmarks: SiteItem[] = [];

        const extractBookmarks = (
            nodes: chrome.bookmarks.BookmarkTreeNode[]
        ) => {
            nodes.forEach((node) => {
                if (node.url) {
                    bookmarks.push({
                        name: node.title,
                        url: node.url,
                        type: "bookmark",
                    });
                }
                if (node.children) {
                    extractBookmarks(node.children);
                }
            });
        };

        extractBookmarks(bookmarkTree);
        return bookmarks; // 全てのブックマークを返す
    } catch (error) {
        console.error("ブックマークの取得に失敗しました:", error);
        return [];
    }
}

/**
 * 履歴を取得してallSitesに追加する関数
 */
async function loadHistory() {
    try {
        const historyItems = await chrome.history.search({
            text: "",
            maxResults: 200,
            startTime: Date.now() - 7 * 24 * 60 * 60 * 1000, // 過去7日間
        });

        return historyItems.map((item) => ({
            name: item.title || item.url || "Unknown",
            url: item.url || "",
            type: "history" as const,
        }));
    } catch (error) {
        console.error("履歴の取得に失敗しました:", error);
        return [];
    }
}

/**
 * 現在開いているタブを取得してallSitesに追加する関数
 */
async function loadCurrentTabs() {
    try {
        const tabs = await chrome.tabs.query({});
        const currentTab = await chrome.tabs.query({
            active: true,
            currentWindow: true,
        });
        const currentTabId = currentTab[0]?.id;

        return tabs
            .filter((tab) => tab.url && tab.title)
            .map((tab) => ({
                name: tab.title || "Unknown",
                url: tab.url || "",
                type: "tab" as const,
                favicon: tab.favIconUrl,
                tabId: tab.id,
                isCurrentTab: tab.id === currentTabId,
            }));
    } catch (error) {
        console.error("タブの取得に失敗しました:", error);
        return [];
    }
}

/**
 * 全てのデータを読み込む関数（非同期で高速化）
 */
async function loadAllData() {
    // まずはプリセットデータで即座に表示（タブがロードされるまでの暫定表示）
    renderLinks(sites);

    try {
        const [bookmarks, history, tabs] = await Promise.all([
            loadBookmarks(),
            loadHistory(),
            loadCurrentTabs(),
        ]);

        // タブのURLセットを作成（重複除去用）
        const tabUrls = new Set(tabs.map((tab) => tab.url));

        // 履歴とブックマークからタブで既に開かれているURLを除外
        const filteredHistory = history.filter(
            (item) => !tabUrls.has(item.url)
        );
        const filteredBookmarks = bookmarks.filter(
            (item) => !tabUrls.has(item.url)
        );

        // タブを優先してallSitesに追加
        allSites = [
            ...sites,
            ...tabs,
            ...filteredBookmarks,
            ...(isHistoryEnabled ? filteredHistory : []), // 履歴フラグに基づいて条件付きで追加
        ];
        isDataLoaded = true;

        // Fuse.jsインスタンスを初期化
        fuse = new Fuse(allSites, fuseOptions);

        // 保留中の検索があれば実行
        if (pendingSearch) {
            performSearch(pendingSearch);
            pendingSearch = "";
        } else {
            // 初期表示を更新（タブを優先表示）
            const initialDisplay = getInitialDisplay();
            renderLinks(initialDisplay);
        }
    } catch (error) {
        console.error("データロードエラー:", error);
        // エラーが発生してもプリセットデータは使用可能
    }
}

// 即座に初期表示を開始
renderLinks(sites);

// 非同期でデータをロード
loadAllData();

// 初期ボタン状態を設定
updateHistoryButtonState();

// === 以下のコードブロックを追加 ===

// キーリピート防止のための変数
let isKeyRepeating = false;
let keyRepeatTimeout: number;

// 検索ボックスでキーが押されたときのイベントリスナー
searchInput.addEventListener("keydown", (e: KeyboardEvent) => {
    // キーリピートの場合はナビゲーション操作を無視
    if (
        e.repeat &&
        (e.key === "n" ||
            e.key === "p" ||
            e.key === "ArrowUp" ||
            e.key === "ArrowDown")
    ) {
        e.preventDefault();
        return;
    }

    switch (e.key) {
        case "Enter":
            e.preventDefault();
            if (filteredSites.length > 0 && filteredSites[selectedIndex]) {
                navigateToSite(filteredSites[selectedIndex]);
            }
            break;

        case "ArrowDown":
        case "n":
            if (e.ctrlKey && e.key === "n") {
                e.preventDefault();
                if (!isKeyRepeating) {
                    isKeyRepeating = true;
                    selectedIndex = Math.min(
                        selectedIndex + 1,
                        filteredSites.length - 1
                    );
                    updateSelection();
                    updatePreview();

                    // キーリピート防止のタイマー
                    clearTimeout(keyRepeatTimeout);
                    keyRepeatTimeout = setTimeout(() => {
                        isKeyRepeating = false;
                    }, 100) as unknown as number;
                }
            } else if (e.key === "ArrowDown") {
                e.preventDefault();
                if (!isKeyRepeating) {
                    isKeyRepeating = true;
                    selectedIndex = Math.min(
                        selectedIndex + 1,
                        filteredSites.length - 1
                    );
                    updateSelection();
                    updatePreview();

                    clearTimeout(keyRepeatTimeout);
                    keyRepeatTimeout = setTimeout(() => {
                        isKeyRepeating = false;
                    }, 100) as unknown as number;
                }
            }
            break;

        case "ArrowUp":
        case "p":
            if (e.ctrlKey && e.key === "p") {
                e.preventDefault();
                if (!isKeyRepeating) {
                    isKeyRepeating = true;
                    selectedIndex = Math.max(selectedIndex - 1, 0);
                    updateSelection();
                    updatePreview();

                    clearTimeout(keyRepeatTimeout);
                    keyRepeatTimeout = setTimeout(() => {
                        isKeyRepeating = false;
                    }, 100) as unknown as number;
                }
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                if (!isKeyRepeating) {
                    isKeyRepeating = true;
                    selectedIndex = Math.max(selectedIndex - 1, 0);
                    updateSelection();
                    updatePreview();

                    clearTimeout(keyRepeatTimeout);
                    keyRepeatTimeout = setTimeout(() => {
                        isKeyRepeating = false;
                    }, 100) as unknown as number;
                }
            }
            break;

        case "h":
            if (e.ctrlKey) {
                e.preventDefault();
                toggleHistoryDisplay();
            }
            break;
    }
});

/**
 * 選択状態を更新する関数
 */
function updateSelection() {
    const linkElements = linksContainer?.querySelectorAll(".link-item");
    linkElements?.forEach((element, index) => {
        if (index === selectedIndex) {
            element.classList.add("selected");
            // 選択された要素が見える位置にスクロール
            element.scrollIntoView({
                behavior: "smooth",
                block: "nearest",
                inline: "nearest",
            });
        } else {
            element.classList.remove("selected");
        }
    });
}

/**
 * プレビューを更新する関数
 */
function updatePreview() {
    if (!previewContainer || filteredSites.length === 0) return;

    const selectedSite = filteredSites[selectedIndex];
    if (!selectedSite) return;

    // 既存タブ情報を取得
    const existingTab =
        selectedSite.type !== "tab" ? findExistingTab(selectedSite.url) : null;

    let statusInfo = "";
    if (selectedSite.isCurrentTab) {
        statusInfo = '<span class="status-current">📍 Current Tab</span>';
    } else if (selectedSite.type === "tab") {
        statusInfo = '<span class="status-open">📑 Open Tab</span>';
    } else if (existingTab) {
        statusInfo = '<span class="status-open">📑 Already Open</span>';
    }

    // ファビコンURLの生成（エラーハンドリング付き）
    let faviconUrl = selectedSite.favicon;
    if (!faviconUrl) {
        try {
            faviconUrl = `https://www.google.com/s2/favicons?domain=${
                new URL(selectedSite.url).hostname
            }`;
        } catch (error) {
            faviconUrl = "https://www.google.com/favicon.ico";
        }
    }

    previewContainer.innerHTML = `
        <div class="preview-header">
            <img src="${faviconUrl}" 
                 alt="" class="preview-favicon" width="16" height="16">
            <span class="preview-title">${selectedSite.name}</span>
            <span class="type-badge ${selectedSite.type}">${
        selectedSite.type
    }</span>
        </div>
        <div class="preview-url">${selectedSite.url}</div>
        ${statusInfo ? `<div class="preview-status">${statusInfo}</div>` : ""}
    `;
}

/**
 * Fuse.jsを使ったあいまい検索を行う関数
 */
function fuzzySearchWithFuse(query: string, sites: SiteItem[]): SiteItem[] {
    if (!query) return sites;

    if (!fuse) {
        fuse = new Fuse(sites, fuseOptions);
    } else {
        fuse.setCollection(sites);
    }

    const results = fuse.search(query);

    // Fuse.jsのスコアのみでソート（スコアが低いほど良い）
    return results.map((result: any) => result.item);
}

/**
 * Web検索用のアイテムを作成する関数
 */
function createWebSearchItem(query: string): SiteItem {
    const encodedQuery = encodeURIComponent(query);
    return {
        name: `🔍 Search "${query}" on Google`,
        url: `https://www.google.com/search?q=${encodedQuery}`,
        type: "preset",
        favicon: "https://www.google.com/favicon.ico",
    };
}

/**
 * 個別のリンク要素作成（関数分離で最適化）
 */
function createLinkElement(site: SiteItem, index: number): HTMLAnchorElement {
    const linkElement = document.createElement("a");
    linkElement.href = site.url;
    linkElement.target = "_blank";

    // Web検索の場合は特別なクラスを追加
    const isWebSearch = site.name.startsWith('🔍 Search "');
    let className = `link-item ${site.type}`;

    if (isWebSearch) {
        className += " web-search";
    }

    if (site.isCurrentTab) {
        className += " current-tab";
    }

    // 既に開いているタブかチェック（ただし、site自体がタブの場合は除く）
    const existingTab = site.type !== "tab" ? findExistingTab(site.url) : null;
    if (existingTab && site.type !== "tab") {
        className += " existing-tab";
    }

    linkElement.className = className;
    linkElement.dataset.index = index.toString();

    // ファビコン要素
    const iconElement = document.createElement("img");
    iconElement.className = "favicon";

    // ファビコンのURL設定（エラーハンドリング付き）
    try {
        iconElement.src =
            site.favicon ||
            `https://www.google.com/s2/favicons?domain=${
                new URL(site.url).hostname
            }`;
    } catch (error) {
        // URLが無効な場合はデフォルトのファビコンを使用
        iconElement.src = "https://www.google.com/favicon.ico";
    }

    iconElement.alt = "";
    iconElement.width = 16;
    iconElement.height = 16;

    // コンテンツコンテナ
    const contentContainer = document.createElement("div");
    contentContainer.className = "content-container";

    const textElement = document.createElement("span");
    textElement.className = "site-name";

    // タブ情報を追加
    let displayName = site.name;
    if (site.isCurrentTab) {
        displayName = `📍 ${site.name} (Current)`;
    } else if (site.type === "tab") {
        displayName = `📑 ${site.name}`;
    } else if (existingTab) {
        displayName = `📑 ${site.name} (Open)`;
    }

    textElement.textContent = displayName;

    const urlElement = document.createElement("span");
    urlElement.className = "site-url";
    urlElement.textContent = site.url;

    const typeElement = document.createElement("span");
    typeElement.className = "type-badge";
    typeElement.textContent = site.type;

    // 要素を組み立て
    contentContainer.appendChild(textElement);
    contentContainer.appendChild(urlElement);
    linkElement.appendChild(iconElement);
    linkElement.appendChild(contentContainer);
    linkElement.appendChild(typeElement);

    // イベントリスナー（パフォーマンス重視で簡潔に）
    linkElement.addEventListener("click", (e: MouseEvent) => {
        e.preventDefault();
        navigateToSite(site);
    });

    return linkElement;
}

/**
 * URLが既に開いているタブかどうかをチェック
 */
function findExistingTab(url: string): SiteItem | null {
    return (
        allSites.find(
            (site) => site.type === "tab" && site.url === url && site.tabId
        ) || null
    );
}

/**
 * タブに移動またはページを開く
 */
async function navigateToSite(site: SiteItem) {
    try {
        // タブアイテムの場合は、そのタブIDを直接使用
        if (site.type === "tab" && site.tabId) {
            // 指定されたタブに移動
            await chrome.tabs.update(site.tabId, { active: true });
            // タブのウィンドウにもフォーカス
            const tab = await chrome.tabs.get(site.tabId);
            if (tab.windowId) {
                await chrome.windows.update(tab.windowId, { focused: true });
            }
            return;
        }

        // タブ以外のアイテムの場合は、既に開いているタブかチェック
        const existingTab = findExistingTab(site.url);

        if (existingTab && existingTab.tabId) {
            // 既存のタブに移動
            await chrome.tabs.update(existingTab.tabId, { active: true });
            // タブのウィンドウにもフォーカス
            const tab = await chrome.tabs.get(existingTab.tabId);
            if (tab.windowId) {
                await chrome.windows.update(tab.windowId, { focused: true });
            }
        } else {
            // 新しいタブで開く
            await chrome.tabs.create({ url: site.url });
        }
    } catch (error) {
        console.error("ナビゲーションエラー:", error);
        // フォールバック: 新しいタブで開く
        chrome.tabs.create({ url: site.url });
    }
}

/**
 * 初期表示用のデータを取得する関数（タブを優先）
 */
function getInitialDisplay(): SiteItem[] {
    if (!isDataLoaded) {
        return sites.slice(0, 30);
    }

    // タブ、プリセット、ブックマーク、履歴の順で優先表示
    const tabs = allSites.filter((site) => site.type === "tab");
    const presets = allSites.filter((site) => site.type === "preset");
    const bookmarks = allSites
        .filter((site) => site.type === "bookmark")
        .slice(0, 10);
    const history = isHistoryEnabled
        ? allSites.filter((site) => site.type === "history").slice(0, 5)
        : []; // 履歴が無効の場合は空配列

    const combined = [...tabs, ...presets, ...bookmarks, ...history];
    return combined.slice(0, 30);
}

/**
 * 履歴表示の有効/無効を切り替える関数
 */
function toggleHistoryDisplay() {
    isHistoryEnabled = !isHistoryEnabled;

    // データを再ロードして表示を更新
    if (isDataLoaded) {
        loadAllData();
    }

    // ボタンの状態を更新
    updateHistoryButtonState();
}

// ボタンのクリックイベントリスナーを追加
historyToggleButton.addEventListener("click", (e: MouseEvent) => {
    e.preventDefault();
    toggleHistoryDisplay();
});

// 初期ボタン状態を設定
function updateHistoryButtonState() {
    if (isHistoryEnabled) {
        historyToggleButton.classList.remove("inactive");
        historyToggleButton.classList.add("active");
        historyToggleButton.title = "履歴表示: ON (クリックでOFF)";
    } else {
        historyToggleButton.classList.remove("active");
        historyToggleButton.classList.add("inactive");
        historyToggleButton.title = "履歴表示: OFF (クリックでON)";
    }
}

// 初期ボタン状態を更新
updateHistoryButtonState();
