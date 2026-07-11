// --- INDEXEDDB FOR FOLDER HANDLE PERSISTENCE ---
const DB_NAME = "NotionKanbanDB";
const STORE_NAME = "handles";
const KEY_DIR = "tareasDir";

function getDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            db.createObjectStore(STORE_NAME);
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

async function storeDirHandle(handle) {
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(handle, KEY_DIR);
        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.warn("No se pudo guardar la carpeta en IndexedDB:", e);
    }
}

async function getStoredDirHandle() {
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_NAME, "readonly");
        const request = tx.objectStore(STORE_NAME).get(KEY_DIR);
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.warn("No se pudo obtener la carpeta de IndexedDB:", e);
        return null;
    }
}

async function clearStoredDirHandle() {
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(KEY_DIR);
    } catch (e) {
        console.warn("No se pudo borrar la carpeta de IndexedDB:", e);
    }
}

// --- STATE VARIABLES ---
let tasks = [];
let schema = {};
let activeView = "board";
let currentTask = null;
let theme = "light";
let dirHandle = null;
let filters = {
    search: "",
    prioridad: "",
    proyecto: ""
};

// Colors mapping for tags
const tagColors = {
    "Sin empezar": "gray",
    "En progreso": "blue",
    "Parado": "orange",
    "Listo": "green",
    "Alta": "red",
    "Medio": "yellow",
    "Baja": "blue"
};

// Initialize Application
document.addEventListener("DOMContentLoaded", () => {
    // Load theme from localStorage
    initTheme();

    // Check if we already have a saved folder from a past session
    checkStoredDirectory();

    // Setup global listeners
    setupEventListeners();
});

// Theme Management
function initTheme() {
    const savedTheme = localStorage.getItem("theme");
    const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    
    if (savedTheme) {
        theme = savedTheme;
    } else {
        theme = systemPrefersDark ? "dark" : "light";
    }
    
    document.body.setAttribute("data-theme", theme);
    updateThemeToggleIcon();
}

function toggleTheme() {
    theme = (document.body.getAttribute("data-theme") === "light") ? "dark" : "light";
    document.body.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
    updateThemeToggleIcon();
}

function updateThemeToggleIcon() {
    const icon = document.querySelector("#themeToggleBtn span");
    if (icon) {
        icon.innerText = theme === "dark" ? "light_mode" : "dark_mode";
    }
}

// --- DIRECTORY & PERMISSION MANAGEMENT ---
async function selectDirectory() {
    try {
        if (typeof window.showDirectoryPicker === "undefined") {
            throw new Error("NOT_SUPPORTED");
        }
        
        dirHandle = await window.showDirectoryPicker({
            mode: "readwrite"
        });
        
        // Save to IndexedDB
        await storeDirHandle(dirHandle);
        
        document.getElementById("welcomeScreen").style.display = "none";
        loadTasksFromDirectory();
        showToast("Carpeta conectada correctamente");
    } catch (err) {
        console.error("Directory selection cancelled or failed:", err);
        if (err.message === "NOT_SUPPORTED") {
            alert("Tu navegador actual no soporta la API de acceso a archivos locales (File System Access API).\n\nPara poder leer y escribir directamente en tu Vault de Obsidian, por favor usa un navegador basado en Chromium como Google Chrome, Microsoft Edge, Brave u Opera.");
            showToast("Navegador no soportado");
        } else if (err.name === "AbortError") {
            showToast("Selección de carpeta cancelada");
        } else {
            showToast("Error de acceso: " + err.message);
        }
    }
}

async function changeDirectory() {
    if (confirm("¿Quieres desconectar la carpeta actual? Deberás seleccionar otra carpeta de Obsidian.")) {
        closeSidePeek();
        dirHandle = null;
        tasks = [];
        schema = {};
        await clearStoredDirHandle();
        
        document.getElementById("btnSelectDirectory").innerHTML = `
            <span class="material-symbols-outlined">folder_open</span>
            <span>Conectar Carpeta de Tareas</span>
        `;
        document.getElementById("welcomeScreen").style.display = "flex";
        renderViews();
    }
}

async function checkStoredDirectory() {
    try {
        const storedHandle = await getStoredDirHandle();
        if (storedHandle) {
            // Check queryPermission first
            const permissionOpts = { mode: "readwrite" };
            if (await storedHandle.queryPermission(permissionOpts) === "granted") {
                dirHandle = storedHandle;
                document.getElementById("welcomeScreen").style.display = "none";
                loadTasksFromDirectory();
            } else {
                // Show reconnect button
                document.getElementById("welcomeScreen").style.display = "flex";
                document.getElementById("btnSelectDirectory").innerHTML = `
                    <span class="material-symbols-outlined">folder_open</span>
                    <span>Re-conectar carpeta guardada</span>
                `;
            }
        } else {
            document.getElementById("welcomeScreen").style.display = "flex";
        }
    } catch (e) {
        console.error("Error checking stored directory:", e);
        document.getElementById("welcomeScreen").style.display = "flex";
    }
}

// Request permission trigger on saved handle
async function triggerReconnect() {
    const storedHandle = await getStoredDirHandle();
    if (storedHandle) {
        try {
            const permissionOpts = { mode: "readwrite" };
            const status = await storedHandle.requestPermission(permissionOpts);
            if (status === "granted") {
                dirHandle = storedHandle;
                document.getElementById("welcomeScreen").style.display = "none";
                loadTasksFromDirectory();
                showToast("Carpeta re-conectada");
            } else {
                showToast("Permiso denegado. Selecciona otra carpeta.");
            }
        } catch (e) {
            console.error("Reconnect error:", e);
            selectDirectory();
        }
    } else {
        selectDirectory();
    }
}

// --- FILE SYSTEM TASK CRUD OPERATORS ---
async function loadTasksFromDirectory() {
    if (!dirHandle) return;
    
    tasks = [];
    const schemaVals = {
        "Estado": new Set(["Sin empezar", "En progreso", "Parado", "Listo"]),
        "Responsable": new Set(["Ferran Espuña", "Pablo Candela"]),
        "Tipo de tarea": new Set(["Entender", "Gestionar", "Pensar", "Redactar"]),
        "Prioridad": new Set(["Alta", "Baja", "Medio"]),
        "Proyecto": new Set(["General", "Summer School", "m-sum-free sets"])
    };
    
    try {
        for await (const entry of dirHandle.values()) {
            if (entry.kind === "file" && entry.name.endsWith(".md")) {
                const file = await entry.getFile();
                const content = await file.text();
                
                const parsed = parseMarkdownContent(entry.name, content);
                if (parsed) {
                    tasks.push(parsed);
                    
                    // Populate schema dynamically
                    const props = parsed.properties;
                    for (const propName in schemaVals) {
                        const val = props[propName];
                        if (val) {
                            if (Array.isArray(val)) {
                                val.forEach(v => schemaVals[propName].add(String(v)));
                            } else {
                                schemaVals[propName].add(String(val));
                            }
                        }
                    }
                }
            }
        }
        
        schema = {};
        for (const k in schemaVals) {
            schema[k] = Array.from(schemaVals[k]).sort();
        }
        
        populateFilterOptions();
        renderViews();
        
        // If there's an open task, refresh it in side peek
        if (currentTask) {
            const refreshedTask = tasks.find(t => t.filename === currentTask.filename);
            if (refreshedTask) {
                openSidePeek(refreshedTask);
            } else {
                closeSidePeek();
            }
        }
    } catch (err) {
        console.error("Error loading tasks from directory:", err);
        showToast("Error al leer los archivos de la carpeta");
    }
}

// Parsing Markdown & Frontmatter
function parseMarkdownContent(filename, content) {
    let properties = {};
    let body = content;
    
    if (content.startsWith("---")) {
        const parts = content.split("---");
        if (parts.length >= 3) {
            const yamlText = parts[1];
            body = parts.slice(2).join("---");
            try {
                properties = jsyaml.load(yamlText) || {};
            } catch (e) {
                console.error(`Error parsing YAML in ${filename}:`, e);
                properties = {};
            }
        }
    }
    
    if (!properties.base) {
        properties.base = "[[Tareas.base]]";
    }
    
    return {
        filename: filename,
        title: filename.replace(".md", ""),
        properties: properties,
        body: body
    };
}

// Writing task file
async function writeTaskFile(filename, properties, body) {
    if (!dirHandle) return;
    
    const cleanedProperties = {};
    for (const k in properties) {
        let v = properties[k];
        if (k === "base") {
            cleanedProperties[k] = v;
        } else if (k === "Plazo") {
            cleanedProperties[k] = v ? v.substring(0, 10) : "";
        } else if (k === "Última actualización") {
            cleanedProperties[k] = new Date().toISOString().substring(0, 19).replace('Z', '');
        } else if (k === "Responsable") {
            if (Array.isArray(v)) {
                cleanedProperties[k] = v;
            } else if (typeof v === "string" && v.trim()) {
                cleanedProperties[k] = [v.trim()];
            } else {
                cleanedProperties[k] = [];
            }
        } else {
            cleanedProperties[k] = v;
        }
    }

    if (!cleanedProperties["Última actualización"]) {
        cleanedProperties["Última actualización"] = new Date().toISOString().substring(0, 19).replace('Z', '');
    }
    if (!cleanedProperties["base"]) {
        cleanedProperties["base"] = "[[Tareas.base]]";
    }

    try {
        const yamlText = jsyaml.dump(cleanedProperties, { forceQuotes: false });
        const content = `---\n${yamlText}---\n${body}`;
        
        const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
    } catch (e) {
        console.error("Error writing task file:", e);
        showToast("Error al guardar archivo");
        throw e;
    }
}

// Add New Task
async function addNewTask(initialState) {
    if (!dirHandle) return;
    
    const title = "Nueva Tarea";
    let sanitizedTitle = title.replace(/[\\/*?:"<>|]/g, "").trim();
    let filename = `${sanitizedTitle}.md`;
    
    // Find a unique filename
    let counter = 1;
    let fileExists = true;
    while (fileExists) {
        try {
            await dirHandle.getFileHandle(filename);
            filename = `${sanitizedTitle} (${counter}).md`;
            counter++;
        } catch (e) {
            fileExists = false;
        }
    }
    
    const properties = {
        base: "[[Tareas.base]]",
        Estado: initialState,
        Prioridad: "Medio",
        "Tipo de tarea": "Gestionar",
        Proyecto: "General",
        Responsable: ["Ferran Espuña"],
        Plazo: "",
        "Última actualización": new Date().toISOString()
    };
    
    const body = "\n## Descripción de la tarea\n\n\n## Subtareas\n\n- [ ] \n- [ ] \n- [ ] \n";
    
    try {
        await writeTaskFile(filename, properties, body);
        
        const newTask = {
            filename: filename,
            title: filename.replace(".md", ""),
            properties: properties,
            body: body
        };
        
        tasks.push(newTask);
        renderViews();
        openSidePeek(newTask);
        showToast("Nueva tarea creada");
    } catch (e) {
        console.error("Error creating new task file:", e);
        showToast("Error al crear el archivo de la tarea");
    }
}

// Update Task Property
async function updateTaskProperty(filename, propData) {
    const task = tasks.find(t => t.filename === filename);
    if (!task) return;
    
    // Update local properties
    for (const k in propData) {
        task.properties[k] = propData[k];
    }
    task.properties["Última actualización"] = new Date().toISOString();
    
    try {
        await writeTaskFile(filename, task.properties, task.body);
        
        renderViews();
        
        if (currentTask && currentTask.filename === filename) {
            currentTask = task;
            refreshPropertiesForm();
        }
    } catch (e) {
        console.error("Failed to update task property file:", e);
        showToast("Error al actualizar la propiedad");
    }
}

// Rename Task File
async function saveTaskTitle() {
    if (!currentTask || !dirHandle) return;
    
    const titleInput = document.getElementById("peekTaskTitle");
    const newTitle = titleInput.value.trim();
    if (!newTitle || newTitle === currentTask.title) return;
    
    const sanitizedNew = newTitle.replace(/[\\/*?:"<>|]/g, "").trim();
    let newFilename = `${sanitizedNew}.md`;
    
    // Find unique filename
    if (newFilename.toLowerCase() !== currentTask.filename.toLowerCase()) {
        let counter = 1;
        let fileExists = true;
        while (fileExists) {
            try {
                await dirHandle.getFileHandle(newFilename);
                newFilename = `${sanitizedNew} (${counter}).md`;
                counter++;
            } catch (e) {
                fileExists = false;
            }
        }
    }

    try {
        // Write new file
        await writeTaskFile(newFilename, currentTask.properties, currentTask.body);
        
        // Remove old file
        await dirHandle.removeEntry(currentTask.filename);
        
        // Update local object properties
        currentTask.filename = newFilename;
        currentTask.title = newFilename.replace(".md", "");
        
        showToast("Tarea renombrada");
        
        // Reload all tasks to ensure consistency
        await loadTasksFromDirectory();
    } catch (e) {
        console.error("Error renaming task:", e);
        showToast("Error al renombrar el archivo");
        titleInput.value = currentTask.title;
    }
}

// Delete Task File
async function deleteTask(filename) {
    if (!dirHandle) return;
    try {
        await dirHandle.removeEntry(filename);
        tasks = tasks.filter(t => t.filename !== filename);
        closeSidePeek();
        renderViews();
        showToast("Tarea eliminada");
    } catch (e) {
        console.error("Error deleting file:", e);
        showToast("Error al eliminar el archivo");
    }
}

// Save Note Body Content
function saveTaskBody() {
    if (!currentTask || !dirHandle) return;
    const bodyContent = document.getElementById("peekTaskBody").value;
    
    currentTask.body = bodyContent;
    currentTask.properties["Última actualización"] = new Date().toISOString();
    
    writeTaskFile(currentTask.filename, currentTask.properties, currentTask.body)
        .then(() => {
            const idx = tasks.findIndex(t => t.filename === currentTask.filename);
            if (idx !== -1) {
                tasks[idx].body = currentTask.body;
                tasks[idx].properties["Última actualización"] = currentTask.properties["Última actualización"];
            }
            
            document.getElementById("peekTaskModified").innerText = formatDateTime(currentTask.properties["Última actualización"]);
            
            const indicator = document.getElementById("autosaveIndicator");
            indicator.innerHTML = `<span class="material-symbols-outlined">check_circle</span> Guardado`;
            setTimeout(() => {
                indicator.classList.remove("visible");
            }, 1500);
            
            renderViews();
        })
        .catch(err => {
            console.error("Error saving note:", err);
            showToast("Error al autoguardar");
        });
}

// --- POPULATE FILTERS ---
function populateFilterOptions() {
    const projectFilter = document.getElementById("filterProyecto");
    const prevSelection = projectFilter.value;
    
    projectFilter.innerHTML = '<option value="">Proyecto: Todos</option>';
    
    if (schema.Proyecto) {
        schema.Proyecto.forEach(p => {
            const option = document.createElement("option");
            option.value = p;
            option.innerText = p;
            projectFilter.appendChild(option);
        });
    }
    
    projectFilter.value = prevSelection;
}

// --- RENDER VIEWS & SIDEBAR ---
function renderViews() {
    const filteredTasks = tasks.filter(task => {
        const titleMatch = task.title.toLowerCase().includes(filters.search.toLowerCase()) || 
                           task.body.toLowerCase().includes(filters.search.toLowerCase());
        
        const priorityMatch = !filters.prioridad || task.properties.Prioridad === filters.prioridad;
        const projectMatch = !filters.proyecto || task.properties.Proyecto === filters.proyecto;
        
        return titleMatch && priorityMatch && projectMatch;
    });

    if (activeView === "board") {
        renderBoard(filteredTasks);
    } else {
        renderTable(filteredTasks);
    }
    
    renderSidebarFilters();
}

function renderSidebarFilters() {
    const container = document.getElementById("sidebarStateFilters");
    container.innerHTML = "";
    
    const states = ["Sin empezar", "En progreso", "Parado", "Listo"];
    states.forEach(state => {
        const count = tasks.filter(t => t.properties.Estado === state).length;
        
        const item = document.createElement("div");
        item.className = "sidebar-state-filter-item";
        
        const dotBg = getComputedStyle(document.documentElement).getPropertyValue(`--tag-${tagColors[state]}-text`) || "gray";
        
        item.innerHTML = `
            <div>
                <span class="sidebar-state-dot" style="background-color: ${dotBg}"></span>
                <span>${state}</span>
            </div>
            <span class="column-count">${count}</span>
        `;
        
        item.addEventListener("click", () => {
            document.getElementById("taskSearchInput").value = "";
            document.getElementById("filterPrioridad").value = "";
            document.getElementById("filterProyecto").value = "";
            filters = { search: "", prioridad: "", proyecto: "" };
            
            activeView = "board";
            document.querySelectorAll(".view-tab").forEach(t => {
                t.classList.toggle("active", t.dataset.view === "board");
            });
            document.getElementById("boardView").classList.add("active");
            document.getElementById("tableView").classList.remove("active");
            
            const col = document.querySelector(`.kanban-column[data-state="${state}"]`);
            if (col) {
                col.scrollIntoView({ behavior: "smooth" });
                col.classList.add("highlight");
                setTimeout(() => col.classList.remove("highlight"), 1000);
            }
            renderViews();
        });
        
        container.appendChild(item);
    });
}

// Render Kanban Board View
function renderBoard(filteredTasks) {
    const columns = document.querySelectorAll(".kanban-column");
    
    columns.forEach(column => {
        const state = column.dataset.state;
        const container = column.querySelector(".cards-container");
        const countEl = column.querySelector(".column-count");
        
        container.innerHTML = "";
        
        const columnTasks = filteredTasks.filter(t => t.properties.Estado === state);
        countEl.innerText = columnTasks.length;
        
        columnTasks.forEach(task => {
            const card = createCardElement(task);
            container.appendChild(card);
        });
    });
}

// Create Card DOM Element
function createCardElement(task) {
    const card = document.createElement("div");
    card.className = "task-card";
    card.draggable = true;
    card.dataset.filename = task.filename;
    
    let tagsHtml = "";
    if (task.properties.Prioridad) {
        const pClass = getTagClass("Prioridad", task.properties.Prioridad);
        tagsHtml += `<span class="tag ${pClass}">${task.properties.Prioridad}</span>`;
    }
    if (task.properties.Proyecto) {
        const projClass = getTagClass("Proyecto", task.properties.Proyecto);
        tagsHtml += `<span class="tag ${projClass}">${task.properties.Proyecto}</span>`;
    }
    if (task.properties["Tipo de tarea"]) {
        const typeClass = getTagClass("Tipo de tarea", task.properties["Tipo de tarea"]);
        tagsHtml += `<span class="tag ${typeClass}">${task.properties["Tipo de tarea"]}</span>`;
    }

    let dateHtml = "";
    if (task.properties.Plazo) {
        const overdue = isOverdue(task.properties.Plazo, task.properties.Estado);
        dateHtml = `
            <div class="card-date ${overdue ? 'overdue' : ''}">
                <span class="material-symbols-outlined">calendar_today</span>
                <span>${formatDate(task.properties.Plazo)}</span>
            </div>
        `;
    }

    let assigneeHtml = "";
    if (task.properties.Responsable && task.properties.Responsable.length > 0) {
        assigneeHtml = '<div class="card-assignee">';
        task.properties.Responsable.forEach(r => {
            const initial = r.trim().substring(0, 1).toUpperCase();
            assigneeHtml += `<span class="card-assignee-avatar" title="${r}">${initial}</span>`;
        });
        assigneeHtml += '</div>';
    }

    card.innerHTML = `
        <div class="card-title">${escapeHtml(task.title)}</div>
        <div class="card-tags">${tagsHtml}</div>
        <div class="card-meta">
            ${dateHtml}
            ${assigneeHtml}
        </div>
    `;

    card.addEventListener("click", () => {
        if (card.classList.contains("dragging")) return;
        openSidePeek(task);
    });

    card.addEventListener("dragstart", (e) => {
        card.classList.add("dragging");
        e.dataTransfer.setData("text/plain", task.filename);
        e.dataTransfer.effectAllowed = "move";
    });

    card.addEventListener("dragend", () => {
        card.classList.remove("dragging");
        document.querySelectorAll(".cards-container").forEach(c => c.classList.remove("dragover"));
    });

    return card;
}

// Render Table View
function renderTable(filteredTasks) {
    const tableBody = document.getElementById("tableBody");
    tableBody.innerHTML = "";
    
    if (filteredTasks.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 24px;">No se encontraron tareas</td></tr>`;
        return;
    }

    filteredTasks.forEach(task => {
        const tr = document.createElement("tr");
        
        const stateClass = getTagClass("Estado", task.properties.Estado || "Sin empezar");
        const priorityClass = getTagClass("Prioridad", task.properties.Prioridad || "Medio");
        const projectClass = getTagClass("Proyecto", task.properties.Proyecto || "General");
        const typeClass = getTagClass("Tipo de tarea", task.properties["Tipo de tarea"] || "Gestionar");
        
        const formatAssignees = task.properties.Responsable ? task.properties.Responsable.join(", ") : "-";
        
        tr.innerHTML = `
            <td class="notion-table-row-title">${escapeHtml(task.title)}</td>
            <td><span class="tag ${stateClass}">${task.properties.Estado || "Sin empezar"}</span></td>
            <td><span class="tag ${priorityClass}">${task.properties.Prioridad || "Medio"}</span></td>
            <td><span class="tag ${projectClass}">${task.properties.Proyecto || "General"}</span></td>
            <td>${escapeHtml(formatAssignees)}</td>
            <td><span class="tag ${typeClass}">${task.properties["Tipo de tarea"] || "-"}</span></td>
            <td>${formatDate(task.properties.Plazo)}</td>
        `;

        tr.querySelector(".notion-table-row-title").addEventListener("click", () => {
            openSidePeek(task);
        });

        tableBody.appendChild(tr);
    });
}

// --- SETUP EVENT LISTENERS ---
function setupEventListeners() {
    // Welcome Screen folder picker trigger
    document.getElementById("btnSelectDirectory").addEventListener("click", () => {
        const btn = document.getElementById("btnSelectDirectory");
        if (btn.innerText.includes("Re-conectar")) {
            triggerReconnect();
        } else {
            selectDirectory();
        }
    });

    // Sidebar change directory button
    document.getElementById("btnChangeDirectory").addEventListener("click", changeDirectory);

    // Theme toggle
    document.getElementById("themeToggleBtn").addEventListener("click", toggleTheme);

    // Tab switching
    document.querySelectorAll(".view-tab").forEach(tab => {
        tab.addEventListener("click", () => {
            document.querySelectorAll(".view-tab").forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            
            activeView = tab.dataset.view;
            
            document.getElementById("boardView").classList.toggle("active", activeView === "board");
            document.getElementById("tableView").classList.toggle("active", activeView === "table");
            
            renderViews();
        });
    });

    // Toolbar Filters
    const searchInput = document.getElementById("taskSearchInput");
    searchInput.addEventListener("input", () => {
        filters.search = searchInput.value;
        toggleClearFiltersButton();
        renderViews();
    });

    const sidebarSearch = document.getElementById("sidebarSearchInput");
    sidebarSearch.addEventListener("input", () => {
        filters.search = sidebarSearch.value;
        searchInput.value = sidebarSearch.value;
        toggleClearFiltersButton();
        renderViews();
    });

    const filterPrioridad = document.getElementById("filterPrioridad");
    filterPrioridad.addEventListener("change", () => {
        filters.prioridad = filterPrioridad.value;
        toggleClearFiltersButton();
        renderViews();
    });

    const filterProyecto = document.getElementById("filterProyecto");
    filterProyecto.addEventListener("change", () => {
        filters.proyecto = filterProyecto.value;
        toggleClearFiltersButton();
        renderViews();
    });

    const clearFiltersBtn = document.getElementById("clearFiltersBtn");
    clearFiltersBtn.addEventListener("click", () => {
        searchInput.value = "";
        sidebarSearch.value = "";
        filterPrioridad.value = "";
        filterProyecto.value = "";
        filters = { search: "", prioridad: "", proyecto: "" };
        clearFiltersBtn.style.display = "none";
        renderViews();
    });

    // Drag and Drop Containers Setup
    document.querySelectorAll(".kanban-column").forEach(column => {
        const container = column.querySelector(".cards-container");
        const state = column.dataset.state;

        container.addEventListener("dragover", (e) => {
            e.preventDefault();
            container.classList.add("dragover");
        });

        container.addEventListener("dragleave", () => {
            container.classList.remove("dragover");
        });

        container.addEventListener("drop", (e) => {
            e.preventDefault();
            container.classList.remove("dragover");
            
            const filename = e.dataTransfer.getData("text/plain");
            if (!filename) return;

            updateTaskProperty(filename, { "Estado": state });
        });
        
        column.querySelector(".add-card-btn").addEventListener("click", () => {
            addNewTask(state);
        });
    });

    // Create New Task buttons
    document.getElementById("btnNewTask").addEventListener("click", () => {
        addNewTask("Sin empezar");
    });

    // Side Peek controls
    document.getElementById("btnCloseSidePeek").addEventListener("click", closeSidePeek);
    document.getElementById("sidePeekBackdrop").addEventListener("click", closeSidePeek);
    
    // Close on Escape key
    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && document.getElementById("sidePeekPanel").classList.contains("active")) {
            closeSidePeek();
        }
    });

    // Open in Obsidian click
    document.getElementById("btnOpenInObsidian").addEventListener("click", () => {
        if (!currentTask) return;
        const vaultName = "Obsidian Vault";
        const folderPath = "Notion/Tareas";
        const filepath = `${folderPath}/${currentTask.title}`;
        const obsidianUrl = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filepath)}`;
        window.location.href = obsidianUrl;
        showToast("Abriendo en Obsidian...");
    });

    // Delete Task click
    document.getElementById("btnDeleteTask").addEventListener("click", () => {
        if (!currentTask) return;
        if (confirm(`¿Estás seguro de que quieres eliminar la tarea "${currentTask.title}"?`)) {
            deleteTask(currentTask.filename);
        }
    });

    // Task Title Change
    const titleInput = document.getElementById("peekTaskTitle");
    titleInput.addEventListener("blur", saveTaskTitle);
    titleInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            titleInput.blur();
        }
    });

    // Task Date Change
    document.getElementById("peekTaskPlazo").addEventListener("change", (e) => {
        if (!currentTask) return;
        updateTaskProperty(currentTask.filename, { "Plazo": e.target.value });
    });

    // Editor tab toggling
    document.querySelectorAll(".editor-tab").forEach(tab => {
        tab.addEventListener("click", () => {
            document.querySelectorAll(".editor-tab").forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            
            const tabName = tab.dataset.tab;
            document.getElementById("editPanel").classList.toggle("active", tabName === "edit");
            document.getElementById("previewPanel").classList.toggle("active", tabName === "preview");
            
            if (tabName === "preview" && currentTask) {
                renderMarkdownPreview();
            }
        });
    });

    // Setup autoguardado for markdown body content
    setupBodyAutosave();

    // Close custom dropdowns on clicking outside
    document.addEventListener("click", (e) => {
        if (!e.target.closest(".custom-select-container")) {
            document.querySelectorAll(".select-dropdown").forEach(d => d.classList.remove("active"));
            document.querySelectorAll(".select-trigger").forEach(t => t.classList.remove("active"));
        }
    });
}

function toggleClearFiltersButton() {
    const clearBtn = document.getElementById("clearFiltersBtn");
    if (filters.search || filters.prioridad || filters.proyecto) {
        clearBtn.style.display = "inline-flex";
    } else {
        clearBtn.style.display = "none";
    }
}

// Setup AutoSave for Note Body
let bodyAutosaveTimeout = null;
function setupBodyAutosave() {
    const textarea = document.getElementById("peekTaskBody");
    textarea.addEventListener("input", () => {
        const indicator = document.getElementById("autosaveIndicator");
        indicator.innerHTML = `<span class="material-symbols-outlined" style="animation: spin 1s linear infinite;">sync</span> Guardando...`;
        indicator.classList.add("visible");
        
        clearTimeout(bodyAutosaveTimeout);
        bodyAutosaveTimeout = setTimeout(() => {
            saveTaskBody();
        }, 1000);
    });
}

// Open Side Peek Modal
function openSidePeek(task) {
    currentTask = task;
    
    document.getElementById("sidePeekPanel").classList.add("active");
    document.getElementById("peekTaskTitle").value = task.title;
    document.getElementById("peekTaskPlazo").value = task.properties.Plazo ? task.properties.Plazo.substring(0,10) : "";
    document.getElementById("peekTaskModified").innerText = formatDateTime(task.properties["Última actualización"]);
    document.getElementById("peekTaskBody").value = task.body;

    document.querySelectorAll(".editor-tab").forEach(t => {
        t.classList.toggle("active", t.dataset.tab === "edit");
    });
    document.getElementById("editPanel").classList.add("active");
    document.getElementById("previewPanel").classList.remove("active");

    refreshPropertiesForm();
}

function closeSidePeek() {
    if (bodyAutosaveTimeout) {
        clearTimeout(bodyAutosaveTimeout);
        saveTaskBody();
    }
    
    currentTask = null;
    document.getElementById("sidePeekPanel").classList.remove("active");
}

// Refresh properties forms
function refreshPropertiesForm() {
    if (!currentTask) return;
    
    const fields = ["Estado", "Prioridad", "Proyecto", "Tipo de tarea", "Responsable"];
    fields.forEach(field => {
        setupCustomSelect(field);
    });
}

// Setup custom selects
function setupCustomSelect(propName) {
    const container = document.querySelector(`.custom-select-container[data-property="${propName}"]`);
    if (!container) return;

    const trigger = container.querySelector(".select-trigger");
    const dropdown = container.querySelector(".select-dropdown");
    const isMultiple = container.dataset.multiple === "true";
    const curVal = currentTask.properties[propName];

    trigger.innerHTML = "";
    if (isMultiple) {
        const arr = Array.isArray(curVal) ? curVal : (curVal ? [curVal] : []);
        if (arr.length === 0) {
            trigger.innerHTML = `<span class="select-trigger-placeholder">Vacío</span>`;
        } else {
            arr.forEach(val => {
                const tagClass = getTagClass(propName, val);
                trigger.innerHTML += `<span class="tag ${tagClass}">${escapeHtml(val)}</span>`;
            });
        }
    } else {
        if (!curVal) {
            trigger.innerHTML = `<span class="select-trigger-placeholder">Vacío</span>`;
        } else {
            const tagClass = getTagClass(propName, curVal);
            trigger.innerHTML = `<span class="tag ${tagClass}">${escapeHtml(curVal)}</span>`;
        }
    }

    trigger.onclick = (e) => {
        e.stopPropagation();
        
        document.querySelectorAll(".select-dropdown").forEach(d => {
            if (d !== dropdown) d.classList.remove("active");
        });
        document.querySelectorAll(".select-trigger").forEach(t => {
            if (t !== trigger) t.classList.remove("active");
        });

        trigger.classList.toggle("active");
        dropdown.classList.toggle("active");
        
        if (dropdown.classList.contains("active")) {
            renderDropdownMenu(propName, dropdown, isMultiple, curVal);
        }
    };
}

// Render dropdown options
function renderDropdownMenu(propName, dropdown, isMultiple, curVal) {
    dropdown.innerHTML = "";
    
    const searchDiv = document.createElement("div");
    searchDiv.className = "select-dropdown-search";
    searchDiv.innerHTML = `<input type="text" placeholder="Buscar o crear..." id="dropdownSearch_${propName}">`;
    dropdown.appendChild(searchDiv);
    
    const optionsContainer = document.createElement("div");
    optionsContainer.className = "select-options-list";
    dropdown.appendChild(optionsContainer);

    const input = searchDiv.querySelector("input");
    input.onclick = (e) => e.stopPropagation();
    
    const filterAndRenderOptions = (filterText = "") => {
        optionsContainer.innerHTML = "";
        
        const list = schema[propName] || [];
        
        list.forEach(val => {
            if (filterText && !val.toLowerCase().includes(filterText.toLowerCase())) return;
            
            const optionDiv = document.createElement("div");
            let isSelected = false;
            
            if (isMultiple) {
                const arr = Array.isArray(curVal) ? curVal : (curVal ? [curVal] : []);
                isSelected = arr.includes(val);
            } else {
                isSelected = curVal === val;
            }
            
            optionDiv.className = `select-option ${isSelected ? 'selected' : ''}`;
            
            const tagClass = getTagClass(propName, val);
            optionDiv.innerHTML = `
                <span class="tag ${tagClass}">${escapeHtml(val)}</span>
                <span class="material-symbols-outlined select-option-checkmark">check</span>
            `;
            
            optionDiv.onclick = (e) => {
                e.stopPropagation();
                if (isMultiple) {
                    let arr = Array.isArray(curVal) ? [...curVal] : (curVal ? [curVal] : []);
                    if (isSelected) {
                        arr = arr.filter(item => item !== val);
                    } else {
                        arr.push(val);
                    }
                    updateTaskProperty(currentTask.filename, { [propName]: arr });
                } else {
                    updateTaskProperty(currentTask.filename, { [propName]: val });
                    dropdown.classList.remove("active");
                }
            };
            
            optionsContainer.appendChild(optionDiv);
        });

        const exactMatch = list.some(item => item.toLowerCase() === filterText.toLowerCase());
        if (filterText && !exactMatch) {
            const addBtn = document.createElement("div");
            addBtn.className = "select-add-option-btn";
            addBtn.innerHTML = `<span class="material-symbols-outlined">add</span><span>Crear "${escapeHtml(filterText)}"</span>`;
            addBtn.onclick = (e) => {
                e.stopPropagation();
                if (!schema[propName]) schema[propName] = [];
                schema[propName].push(filterText);
                
                if (isMultiple) {
                    let arr = Array.isArray(curVal) ? [...curVal] : (curVal ? [curVal] : []);
                    arr.push(filterText);
                    updateTaskProperty(currentTask.filename, { [propName]: arr });
                } else {
                    updateTaskProperty(currentTask.filename, { [propName]: filterText });
                    dropdown.classList.remove("active");
                }
                
                populateFilterOptions();
            };
            optionsContainer.appendChild(addBtn);
        }
    };

    input.oninput = () => {
        filterAndRenderOptions(input.value);
    };

    filterAndRenderOptions("");
    input.focus();
}

// Markdown Preview Render
function renderMarkdownPreview() {
    if (!currentTask) return;
    const previewContainer = document.getElementById("previewPanel");
    
    const preprocessedBody = formatBodyWithCallouts(currentTask.body);
    previewContainer.innerHTML = marked.parse(preprocessedBody);

    // Render LaTeX Math expressions using KaTeX
    if (window.renderMathInElement) {
        window.renderMathInElement(previewContainer, {
            delimiters: [
                {left: '$$', right: '$$', display: true},
                {left: '$', right: '$', display: false},
                {left: '\\(', right: '\\)', display: false},
                {left: '\\[', right: '\\]', display: true}
            ],
            throwOnError: false
        });
    }

    // Enable task list checkboxes and make them interactive
    const checkboxes = previewContainer.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach((cb, index) => {
        cb.removeAttribute('disabled');
        cb.onclick = (e) => e.stopPropagation();
        cb.addEventListener('change', () => {
            toggleMarkdownCheckbox(index, cb.checked);
        });
    });
}

// Toggle checkbox in Markdown body content
function toggleMarkdownCheckbox(index, isChecked) {
    if (!currentTask) return;
    const regex = /((?:[-*+]|\d+\.)\s+\[)([ xX])(\])/g;
    let matchCount = 0;
    const newBody = currentTask.body.replace(regex, (match, p1, p2, p3) => {
        if (matchCount === index) {
            matchCount++;
            return p1 + (isChecked ? 'x' : ' ') + p3;
        }
        matchCount++;
        return match;
    });
    
    currentTask.body = newBody;
    document.getElementById("peekTaskBody").value = newBody;
    saveTaskBody();
}

// Custom parser to format Obsidian Callouts
function formatBodyWithCallouts(text) {
    if (!text) return "";
    
    const lines = text.split("\n");
    const resultLines = [];
    let inCallout = false;
    let calloutType = "";
    let calloutTitle = "";
    let calloutContentLines = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(/^>\s*\[!([a-zA-Z0-9_\-]+)\][+-]?\s*(.*)$/);
        
        if (match) {
            if (inCallout) {
                resultLines.push(buildCalloutHtml(calloutType, calloutTitle, calloutContentLines.join("\n")));
            }
            inCallout = true;
            calloutType = match[1];
            calloutTitle = match[2].trim() || calloutType.charAt(0).toUpperCase() + calloutType.slice(1);
            calloutContentLines = [];
        } else if (inCallout && line.startsWith(">")) {
            const content = line.substring(1).replace(/^\s/, "");
            calloutContentLines.push(content);
        } else {
            if (inCallout) {
                resultLines.push(buildCalloutHtml(calloutType, calloutTitle, calloutContentLines.join("\n")));
                inCallout = false;
            }
            resultLines.push(line);
        }
    }
    
    if (inCallout) {
        resultLines.push(buildCalloutHtml(calloutType, calloutTitle, calloutContentLines.join("\n")));
    }

    return resultLines.join("\n");
}

function buildCalloutHtml(type, title, content) {
    const iconMap = {
        note: "info",
        info: "info",
        todo: "check_circle",
        done: "check_circle",
        warning: "warning",
        error: "error",
        tip: "lightbulb",
        important: "priority_high",
        caution: "dangerous"
    };
    
    const icon = iconMap[type.toLowerCase()] || "info";
    const parsedContent = marked.parse(content);
    
    return `
<div class="callout callout-${type.toLowerCase()}" style="border: 1px solid var(--border-color); border-left: 4px solid var(--tag-${tagColors[type] || 'blue'}-text, var(--accent-color)); background: var(--hover-card); padding: 12px 16px; border-radius: var(--radius-md); margin-bottom: 14px;">
    <div class="callout-header" style="font-weight: 600; display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 14px; color: var(--tag-${tagColors[type] || 'blue'}-text, var(--text-main));">
        <span class="material-symbols-outlined" style="font-size: 18px;">${icon}</span>
        <span>${escapeHtml(title)}</span>
    </div>
    <div class="callout-content" style="font-size: 14px;">
        ${parsedContent}
    </div>
</div>
`;
}

// Helpers
function getTagClass(propName, value) {
    if (tagColors[value]) return `tag-${tagColors[value]}`;
    
    if (!value) return "tag-gray";
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
        hash = value.charCodeAt(i) + ((hash << 5) - hash);
    }
    const colors = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
    const idx = Math.abs(hash) % colors.length;
    return `tag-${colors[idx]}`;
}

function formatDate(dateStr) {
    if (!dateStr) return "";
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        const options = { day: 'numeric', month: 'short' };
        if (d.getFullYear() !== new Date().getFullYear()) {
            options.year = 'numeric';
        }
        return d.toLocaleDateString('es-ES', options);
    } catch(e) {
        return dateStr;
    }
}

function formatDateTime(dateTimeStr) {
    if (!dateTimeStr) return "-";
    try {
        const d = new Date(dateTimeStr);
        if (isNaN(d.getTime())) return dateTimeStr;
        return d.toLocaleDateString('es-ES', { 
            day: 'numeric', 
            month: 'short', 
            hour: '2-digit', 
            minute: '2-digit' 
        });
    } catch(e) {
        return dateTimeStr;
    }
}

function isOverdue(dateStr, state) {
    if (!dateStr || state === "Listo") return false;
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return false;
        const today = new Date();
        today.setHours(0,0,0,0);
        return d < today;
    } catch(e) {
        return false;
    }
}

function escapeHtml(text) {
    if (!text) return "";
    return text
        .toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Toast Notifications
function showToast(message) {
    const container = document.getElementById("toastContainer");
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `
        <span class="material-symbols-outlined">info</span>
        <span>${message}</span>
    `;
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = "toastOut 0.2s ease forwards";
        setTimeout(() => toast.remove(), 200);
    }, 3000);
}

// Add animation code dynamically for toast remove
const styleSheet = document.createElement("style");
styleSheet.innerText = `
@keyframes toastOut {
    from { transform: translateY(0); opacity: 1; }
    to { transform: translateY(-20px); opacity: 0; }
}
@keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}
.kanban-column.highlight {
    outline: 2px solid var(--accent-color);
    border-radius: var(--radius-lg);
    background: var(--hover-bg);
    transition: background 0.3s;
}
`;
document.head.appendChild(styleSheet);
