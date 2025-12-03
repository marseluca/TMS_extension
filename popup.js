"use strict";

// ============================================================================
// CONFIG
// ============================================================================

// URL della search dei job che stavi già usando nel tuo script precedente.
// Sostituisci con il tuo valore reale.
const API_URL = "https://www.translationtms.com/cms/i18n/tsc/admin/be/translation-jobs/list";

// Numero di job per pagina (uguale al pageSize che passavi nell'API).
const PAGE_SIZE = 50;

// LocaleId per Italian (Italy) come visto nella chiamata:
// /translation-jobs/48429/locale/20/assign/171
const IT_LOCALE_ID = 20;

// ============================================================================
// ELEMENTI DOM
// ============================================================================

const loadJobsBtn = document.getElementById("loadJobsBtn");
const sortSelect = document.getElementById("sortSelect");
const projectFilterSelect = document.getElementById("projectFilterSelect");
const statusEl = document.getElementById("status");
const jobsEl = document.getElementById("jobs");
const statusFilterSelect = document.getElementById("statusFilterSelect");
const dateFromInput = document.getElementById("dateFrom");
const dateToInput = document.getElementById("dateTo");


// Stato in memoria
let allJobsRaw = [];
let currentSort = "none";
let currentProjectFilter = "ALL";
let currentStatusFilter = "ALL";  // "ALL" | "WAITING" | "IN_PROGRESS" | "COMPLETED"
let currentDateFrom = null; // Date | null
let currentDateTo = null;   // Date | null



// ============================================================================
// UTIL DI STATO / FORMAT
// ============================================================================

function setStatus(msg, type = "") {
  statusEl.textContent = msg || "";
  statusEl.className = "";
  if (type === "error") statusEl.classList.add("error");
  if (type === "ok") statusEl.classList.add("ok");
}

// Cerca di stimare il wordcount da vari possibili campi
// WORDCOUNT: somma di strings[].wordCount
// WORDCOUNT: usa sia le strings che eventuali totali a livello di job
function getJobWordCount(job) {
  if (!Array.isArray(job.strings)) return 0;

  let total = 0;

  for (const s of job.strings) {
    if (typeof s.wordCount === "number" && !Number.isNaN(s.wordCount)) {
      total += s.wordCount;
    } else if (typeof s.wordCount === "string" && s.wordCount.trim() !== "") {
      const v = Number(s.wordCount);
      if (!Number.isNaN(v)) total += v;
    }
  }

  return total;
}




// Prende una data utile per ordinare (preferibilmente due date)
function getJobDate(job) {
  const raw =
    job.dueDate ??
    job.deadline ??
    job.deliveryDate ??
    job.createdAt ??
    job.createTime ??
    null;

  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

// Formatta la due date in stile "4 dicembre"
function formatDueDateForDisplay(job) {
  const d = getJobDate(job);
  if (!d) return "-";
  return d.toLocaleDateString("it-IT", {
    day: "numeric",
    month: "long"
  });
}

// ============================================================================
// LETTURA TOKEN E USER INFO DALLA SCHEDA ATTIVA
// ============================================================================

// auth_token da localStorage della pagina TMS
function getAuthToken() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      if (!tab) {
        reject(new Error("Nessuna scheda attiva trovata."));
        return;
      }

      const url = tab.url || "";
      if (!url.startsWith("https://www.translationtms.com/")) {
        reject(
          new Error(
            "La scheda attiva non è translationtms.com. Apri il TMS, fai login e poi clicca l’icona dell’estensione."
          )
        );
        return;
      }

      chrome.scripting.executeScript(
        {
          target: { tabId: tab.id },
          func: () => {
            try {
              return localStorage.getItem("auth_token");
            } catch (e) {
              return null;
            }
          }
        },
        results => {
          if (chrome.runtime.lastError) {
            reject(
              new Error(
                "Errore esecuzione script: " +
                  chrome.runtime.lastError.message
              )
            );
            return;
          }

          if (!results || !results.length) {
            reject(
              new Error(
                "Nessun risultato dallo script nella scheda. Ricarica la pagina del TMS e riprova."
              )
            );
            return;
          }

          const token = results[0].result;
          if (!token) {
            reject(
              new Error(
                "auth_token non trovato in localStorage. Sei loggato in translationtms.com?"
              )
            );
            return;
          }

          resolve(token);
        }
      );
    });
  });
}

// user_info (per recuperare il tuo userId -> assigneeId)
function getUserInfo() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      if (!tab) {
        reject(new Error("Nessuna scheda attiva trovata."));
        return;
      }

      const url = tab.url || "";
      if (!url.startsWith("https://www.translationtms.com/")) {
        reject(
          new Error(
            "La scheda attiva non è translationtms.com. Apri il TMS, fai login e poi clicca l’icona dell’estensione."
          )
        );
        return;
      }

      chrome.scripting.executeScript(
        {
          target: { tabId: tab.id },
          func: () => {
            try {
              const raw = localStorage.getItem("user_info");
              return raw ? JSON.parse(raw) : null;
            } catch (e) {
              return null;
            }
          }
        },
        results => {
          if (chrome.runtime.lastError) {
            reject(
              new Error(
                "Errore esecuzione script (user_info): " +
                  chrome.runtime.lastError.message
              )
            );
            return;
          }

          if (!results || !results.length) {
            reject(
              new Error(
                "Nessun risultato dallo script nella scheda (user_info)."
              )
            );
            return;
          }

          const info = results[0].result;
          if (!info || typeof info.id !== "number") {
            reject(
              new Error(
                "user_info.id non trovato in localStorage. Controlla che il login TMS sia andato a buon fine."
              )
            );
            return;
          }

          resolve(info);
        }
      );
    });
  });
}

// ============================================================================
// FETCH DELLE PAGINE DI JOB
// ============================================================================

function extractList(data) {
  let list =
    data?.data?.list ??
    data?.data?.items ??
    data?.data?.jobs ??
    data?.list ??
    data?.items ??
    data?.jobs ??
    null;

  if (!list && Array.isArray(data)) {
    list = data;
  }

  if (!Array.isArray(list)) {
    console.warn("Formato risposta inatteso, data:", data);
    return [];
  }

  return list;
}

async function fetchJobsPage(token, page) {
  const body = {
    page: page,
    pageSize: PAGE_SIZE,
    jobName: "",
    statuses: [],      // puoi adattare se vuoi filtrare lato server
    projectIds: [],
    tab: "job"         // come nel tuo script precedente
  };

  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status} – ${resp.statusText}\n${text}`);
  }

  const data = await resp.json();
  console.log("Risposta pagina", page, ":", data);
  return data;
}

async function fetchAllJobs(token) {
  const allJobs = [];
  let page = 1;

  while (true) {
    setStatus(`Carico pagina ${page}.`, "");
    const data = await fetchJobsPage(token, page);
    const list = extractList(data);

    if (!list || list.length === 0) {
      break; // nessun altro job
    }

    allJobs.push(...list);

    if (list.length < PAGE_SIZE) {
      // ultima pagina
      break;
    }

    page++;

    // sicurezza per evitare loop infiniti
    if (page > 1000) {
      console.warn("Interrotto a pagina 1000 (limite di sicurezza).");
      break;
    }
  }

  return allJobs;
}

// ============================================================================
// ACCEPT DEL SINGOLO JOB
// ============================================================================

// Qui uso IT_LOCALE_ID fisso (20) per l'Italiano.
// Se in futuro vuoi supportare più lingue, puoi mappare job.localeId o simili.
function getLocaleIdForJob(job) {
  // Se l'API del job già ti dà il localeId, metti quella logica qui,
  // ad esempio:
  //
  // if (typeof job.localeId === "number") return job.localeId;
  //
  // Per ora assumiamo tutti job Italian (Italy):
  return IT_LOCALE_ID;
}

async function acceptJob(job, cardEl, acceptBtn) {
  try {
    setStatus(`Accetto job ${job.id}...`, "");

    const [token, userInfo] = await Promise.all([getAuthToken(), getUserInfo()]);
    const assigneeId = userInfo.id;

    const email =
      userInfo.email ||
      userInfo.username ||
      userInfo.userName ||
      userInfo.user_email ||
      null;

    const localeId = getLocaleIdForJob(job);

    if (!job.id) {
      throw new Error("job.id mancante nei dati del job.");
    }
    if (!localeId) {
      throw new Error("localeId non determinato per questo job.");
    }
    if (!assigneeId) {
      throw new Error("assigneeId (userInfo.id) non trovato.");
    }

    const url = `https://www.translationtms.com/cms/i18n/tsc/admin/be/translation-jobs/${job.id}/locale/${localeId}/assign/${assigneeId}`;

    const headers = {
      "accept": "application/json, text/plain, */*",
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "x-okta-type": "okta"
    };

    if (email) {
      headers["x-user-email"] = email;
    }

    const resp = await fetch(url, {
      method: "POST",
      mode: "cors",
      credentials: "include",
      headers,
      body: "{}"
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HTTP ${resp.status} – ${resp.statusText}\n${text}`);
    }

    setStatus(`Job ${job.id} accettato correttamente.`, "ok");

    // Cambia subito lo sfondo del job
    if (cardEl) {
      cardEl.classList.add("job-accepted");
    }

    // Rendi il pulsante "fisso" per dare feedback
    if (acceptBtn) {
      acceptBtn.disabled = true;
      acceptBtn.textContent = "Accepted";
      acceptBtn.classList.add("job-accept-btn-disabled");
    }

  } catch (err) {
    console.error("Errore accept job:", err);
    setStatus(`Errore accept job ${job.id}: ${err.message}`, "error");
  }
}



// ============================================================================
// RENDER UI
// ============================================================================

function updateProjectFilterOptions() {
  const current = currentProjectFilter;

  const names = Array.from(
    new Set(
      allJobsRaw
        .map(j => j.tmsProject?.name)
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));

  projectFilterSelect.innerHTML = "";

  const optAll = document.createElement("option");
  optAll.value = "ALL";
  optAll.textContent = "Tutti i progetti";
  projectFilterSelect.appendChild(optAll);

  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    projectFilterSelect.appendChild(opt);
  }

  if (names.includes(current)) {
    projectFilterSelect.value = current;
  } else {
    currentProjectFilter = "ALL";
    projectFilterSelect.value = "ALL";
  }
}

function applyFiltersAndRender() {
  let jobs = Array.from(allJobsRaw);

  // filtro per STATUS
  if (currentStatusFilter !== "ALL") {
    jobs = jobs.filter((job) => {
      const s = (job.status || "").toUpperCase();
      return s === currentStatusFilter;
    });
  }

  // filtro per PROGETTO
  if (currentProjectFilter !== "ALL") {
    jobs = jobs.filter(
      (job) => (job.tmsProject?.name ?? "") === currentProjectFilter
    );
  }

  // filtro per DATA (intervallo [dateFrom, dateTo])
  if (currentDateFrom || currentDateTo) {
    jobs = jobs.filter((job) => {
      const d = getJobDate(job);
      if (!d) return false;

      if (currentDateFrom && d < currentDateFrom) return false;
      if (currentDateTo && d > currentDateTo) return false;

      return true;
    });
  }

  // ORDINAMENTO
  if (currentSort === "dateAsc" || currentSort === "dateDesc") {
    jobs.sort((a, b) => {
      const da = getJobDate(a);
      const db = getJobDate(b);

      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;

      return currentSort === "dateAsc" ? da - db : db - da;
    });
  } else if (currentSort === "wcAsc" || currentSort === "wcDesc") {
    jobs.sort((a, b) => {
      const wa = getJobWordCount(a);
      const wb = getJobWordCount(b);
      return currentSort === "wcAsc" ? wa - wb : wb - wa;
    });
  }

  renderJobs(jobs);
}



function renderJobs(list) {
  jobsEl.innerHTML = "";

  if (!Array.isArray(list) || list.length === 0) {
    jobsEl.textContent = "Nessun job trovato.";
    return;
  }

  for (const job of list) {
    const el = document.createElement("div");
    el.className = "job";

    const title = document.createElement("div");
    title.className = "job-title";
    title.textContent = `${job.id} — ${job.jobName ?? "(senza nome)"}`;

    const projectName = job.tmsProject?.name ?? "N/A";
    const statusRaw = job.status ?? "N/A";
    const s = statusRaw.toUpperCase();
    const wc = getJobWordCount(job);
    const dueDateStr = formatDueDateForDisplay(job);

    const grid = document.createElement("div");
    grid.className = "job-grid";

    // Progetto
    const colProject = document.createElement("div");
    const projLabel = document.createElement("div");
    projLabel.className = "job-col-label";
    projLabel.textContent = "Progetto";
    const projValue = document.createElement("div");
    projValue.className = "job-col-value";
    projValue.textContent = projectName;
    colProject.appendChild(projLabel);
    colProject.appendChild(projValue);

    // Wordcount
    const colWc = document.createElement("div");
    const wcLabel = document.createElement("div");
    wcLabel.className = "job-col-label";
    wcLabel.textContent = "Wordcount";
    const wcValue = document.createElement("div");
    wcValue.className = "job-col-value";
    wcValue.textContent = wc.toLocaleString("it-IT");
    colWc.appendChild(wcLabel);
    colWc.appendChild(wcValue);

    // Due date
    const colDate = document.createElement("div");
    const dateLabel = document.createElement("div");
    dateLabel.className = "job-col-label";
    dateLabel.textContent = "Due date";
    const dateValue = document.createElement("div");
    dateValue.className = "job-col-value";
    dateValue.textContent = dueDateStr;
    colDate.appendChild(dateLabel);
    colDate.appendChild(dateValue);

    // Status (pill colorata)
    const colStatus = document.createElement("div");
    const statusLabelEl = document.createElement("div");
    statusLabelEl.className = "job-col-label";
    statusLabelEl.textContent = "Status";
    const statusValue = document.createElement("div");
    statusValue.className = "job-col-value status-pill";
    statusValue.textContent = statusRaw;
    statusValue.dataset.status = s; // per lo stile CSS
    colStatus.appendChild(statusLabelEl);
    colStatus.appendChild(statusValue);

    grid.appendChild(colProject);
    grid.appendChild(colWc);
    grid.appendChild(colDate);
    grid.appendChild(colStatus);

    // Actions in base allo status
    const actions = document.createElement("div");
    actions.className = "job-actions";

    if (s === "WAITING") {
    const acceptBtn = document.createElement("button");
    acceptBtn.textContent = "Accept";
    acceptBtn.className = "job-accept-btn";
    acceptBtn.addEventListener("click", () => {
      acceptJob(job, el, acceptBtn);
    });
    actions.appendChild(acceptBtn);

    } else if (s === "IN_PROGRESS") {
      // SOLO IN_PROGRESS -> pulsante Edit che apre in NUOVA scheda
      const editBtn = document.createElement("button");
      editBtn.textContent = "Edit";
      editBtn.className = "job-edit-btn";
      editBtn.addEventListener("click", () => {
        const localeId = getLocaleIdForJob(job); // nel tuo caso 20

        const editUrl =
          "https://www.translationtms.com/translation-work/" +
          job.id +
          "/" +
          localeId;

          chrome.tabs.create({ url: editUrl, active: false });
      });
      actions.appendChild(editBtn);

    } else if (s === "COMPLETED") {
      // COMPLETED -> nessun pulsante
      // nessuna azione da aggiungere
    }

    el.appendChild(title);
    el.appendChild(grid);

    // Aggiungi il blocco actions solo se ha pulsanti
    if (actions.childElementCount > 0) {
      el.appendChild(actions);
    }

    jobsEl.appendChild(el);
  }
}


// ============================================================================
// HANDLER UI
// ============================================================================

async function reloadJobs() {
  try {
    setStatus("Recupero token…", "");
    const token = await getAuthToken();
    setStatus("Carico job…", "");
    allJobsRaw = await fetchAllJobs(token);
    setStatus(`Job trovati: ${allJobsRaw.length}`, "ok");
    updateProjectFilterOptions();
    applyFiltersAndRender();
  } catch (err) {
    console.error(err);
    setStatus(err.message, "error");
  }
}

loadJobsBtn.addEventListener("click", () => {
  reloadJobs();
});

sortSelect.addEventListener("change", () => {
  currentSort = sortSelect.value;
  applyFiltersAndRender();
});

projectFilterSelect.addEventListener("change", () => {
  currentProjectFilter = projectFilterSelect.value;
  applyFiltersAndRender();
});

// Cambio filtro per status
statusFilterSelect.addEventListener("change", () => {
  currentStatusFilter = statusFilterSelect.value;
  applyFiltersAndRender();
});

if (dateFromInput) {
  dateFromInput.addEventListener("change", () => {
    if (dateFromInput.value) {
      // inizio giornata
      currentDateFrom = new Date(dateFromInput.value + "T00:00:00");
    } else {
      currentDateFrom = null;
    }
    applyFiltersAndRender();
  });
}

if (dateToInput) {
  dateToInput.addEventListener("change", () => {
    if (dateToInput.value) {
      // fine giornata
      currentDateTo = new Date(dateToInput.value + "T23:59:59");
    } else {
      currentDateTo = null;
    }
    applyFiltersAndRender();
  });
}




// opzionale: carica subito all'apertura del popup
// reloadJobs();
