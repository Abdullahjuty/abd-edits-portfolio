const nav = document.querySelector(".nav");
const toggle = document.querySelector(".menu-toggle");
const links = document.querySelectorAll(".nav-links a");
const playBtn = document.querySelector(".play-vsl");
const vslVideo = document.querySelector("#vsl-video");
const modal = document.querySelector(".modal");
const modalClose = document.querySelector(".modal-close");
const year = document.querySelector("#year");

if (year) year.textContent = new Date().getFullYear();

toggle?.addEventListener("click", () => {
  nav.classList.toggle("open");
});

links.forEach((link) => {
  link.addEventListener("click", () => nav.classList.remove("open"));
});

const sections = [...document.querySelectorAll("section[id]")];

const setActive = () => {
  const y = window.scrollY + 120;
  let current = sections[0]?.id;
  for (const section of sections) {
    if (section.offsetTop <= y) current = section.id;
  }
  links.forEach((link) => {
    link.classList.toggle("active", link.getAttribute("href") === `#${current}`);
  });
};

window.addEventListener("scroll", setActive, { passive: true });
setActive();

const startVsl = async () => {
  if (!vslVideo || !vslVideo.src) return;
  playBtn?.classList.add("hide");
  vslVideo.controls = true;
  vslVideo.muted = false;
  try {
    await vslVideo.play();
  } catch {
    vslVideo.muted = true;
    try {
      await vslVideo.play();
    } catch {
      modal?.classList.add("open");
      const modalVideo = modal?.querySelector("video");
      modalVideo?.play().catch(() => {});
    }
  }
};

playBtn?.addEventListener("click", startVsl);

modalClose?.addEventListener("click", () => {
  modal?.classList.remove("open");
  const modalVideo = modal?.querySelector("video");
  modalVideo?.pause();
});

modal?.addEventListener("click", (event) => {
  if (event.target === modal) modalClose?.click();
});

// ---------------------------------------------------------------------
// Patch-load strategy: each marquee video only starts fetching bytes once
// it scrolls near the viewport (the browser streams it in range-request
// chunks — the same "patches" it keeps pulling as playback continues).
// Once loaded, a clip is never unloaded/reset again, so the CSS marquee
// animation and the video's own playback both stay perfectly smooth and
// never stutter, freeze, or need to re-buffer.
// ---------------------------------------------------------------------
const ensurePlaying = (video) => {
  const attempt = () =>
    video.play().catch(() => {
      video.muted = true;
      requestAnimationFrame(() => video.play().catch(() => {}));
    });
  attempt();
};

const clipObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      const video = entry.target;
      if (entry.isIntersecting) {
        if (!video.src && video.dataset.src) {
          video.src = video.dataset.src;
          video.load();
        }
        ensurePlaying(video);
      }
    });
  },
  { rootMargin: "200px 600px", threshold: 0.01 }
);

function buildClipEl(clip) {
  const article = document.createElement("article");
  article.className = `clip${clip.size && clip.size !== "normal" ? ` ${clip.size}` : ""}`;

  if (clip.type === "video" && clip.src) {
    const video = document.createElement("video");
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "none";
    if (clip.poster) video.poster = clip.poster;
    video.dataset.src = clip.src;
    article.appendChild(video);
    clipObserver.observe(video);
  } else {
    const img = document.createElement("img");
    img.src = clip.poster || clip.src;
    img.alt = clip.tag || "Portfolio clip";
    img.loading = "lazy";
    img.decoding = "async";
    article.appendChild(img);
  }

  if (clip.time) {
    const time = document.createElement("span");
    time.className = "clip-time";
    time.textContent = clip.time;
    article.appendChild(time);
  }
  if (clip.tag) {
    const tag = document.createElement("span");
    tag.className = "clip-tag";
    tag.textContent = clip.tag;
    article.appendChild(tag);
  }
  return article;
}

function renderRow(rowEl, clips) {
  if (!rowEl) return;
  rowEl.innerHTML = "";
  if (clips.length === 0) return;
  // Duplicate the set once so the CSS translateX(-50%) loop is seamless.
  [...clips, ...clips].forEach((clip) => rowEl.appendChild(buildClipEl(clip)));
}

function renderClips(clips) {
  renderRow(document.getElementById("row-rtl"), clips.filter((c) => c.row === "rtl"));
  renderRow(document.getElementById("row-ltr"), clips.filter((c) => c.row === "ltr"));
  renderRow(document.getElementById("row-rtl-slow"), clips.filter((c) => c.row === "rtl-slow"));
}

function renderTestimonials(testimonials) {
  const podium = document.getElementById("podium");
  if (!podium) return;
  podium.innerHTML = "";
  testimonials.forEach((t) => {
    const article = document.createElement("article");
    article.className = `quote-card${t.featured ? " featured" : ""}`;
    article.innerHTML = `
      ${t.place ? `<div class="place">${t.place}</div>` : ""}
      <p>"${t.quote}"</p>
      <div class="who">
        <div class="avatar">${t.avatar}</div>
        <div>
          <b>${t.name}</b>
          <span>${t.role}</span>
        </div>
      </div>
    `;
    podium.appendChild(article);
  });
}

function renderPricing(pricing) {
  const grid = document.getElementById("pricing-grid");
  if (!grid) return;
  grid.innerHTML = "";
  pricing.forEach((plan) => {
    const article = document.createElement("article");
    article.className = `plan${plan.hot ? " hot" : ""}`;
    article.innerHTML = `
      <h3>${plan.name}</h3>
      <div class="price">${plan.price} <small>${plan.unit}</small></div>
      <ul>${plan.features.map((f) => `<li>${f}</li>`).join("")}</ul>
      <a class="btn${plan.hot ? "" : " btn-ghost"}" href="#contact">${plan.cta}</a>
    `;
    grid.appendChild(article);
  });
}

function renderHero(hero) {
  const eyebrow = document.getElementById("hero-eyebrow");
  const h1 = document.getElementById("hero-headline1");
  const h2 = document.getElementById("hero-headline2");
  const vp = document.getElementById("hero-value-prop");
  const statsWrap = document.getElementById("hero-stats");
  if (eyebrow && hero.eyebrow) eyebrow.textContent = hero.eyebrow;
  if (h1 && hero.headline1) h1.textContent = hero.headline1;
  if (h2 && hero.headline2) h2.textContent = hero.headline2;
  if (vp && hero.valueProp) vp.textContent = hero.valueProp;
  if (statsWrap && Array.isArray(hero.stats)) {
    statsWrap.innerHTML = hero.stats
      .map((s) => `<div class="stat"><b>${s.value}</b><span>${s.label}</span></div>`)
      .join("");
  }

  if (vslVideo && hero.vslVideo) {
    if (hero.vslPoster) vslVideo.poster = hero.vslPoster;
    vslVideo.dataset.src = hero.vslVideo;
    vslVideo.src = ""; // stays unset until play is pressed
    vslVideo.removeAttribute("src");
  }

  const modalVideo = document.getElementById("modal-vsl");
  if (modalVideo && hero.vslVideo) {
    if (hero.vslPoster) modalVideo.poster = hero.vslPoster;
  }
}

// The hero VSL only fetches its full video once the user actually presses
// play — until then only the poster image (a single lightweight file) loads.
playBtn?.addEventListener(
  "click",
  () => {
    if (vslVideo && !vslVideo.getAttribute("src") && vslVideo.dataset.src) {
      vslVideo.src = vslVideo.dataset.src;
      vslVideo.load();
    }
    const modalVideo = document.getElementById("modal-vsl");
    if (modalVideo && !modalVideo.getAttribute("src") && vslVideo?.dataset.src) {
      modalVideo.src = vslVideo.dataset.src;
    }
  },
  { once: false }
);

async function loadContent() {
  try {
    const res = await fetch("/api/content");
    const content = await res.json();
    renderHero(content.hero || {});
    renderClips(content.clips || []);
    renderTestimonials(content.testimonials || []);
    renderPricing(content.pricing || []);
  } catch (err) {
    console.error("Failed to load site content:", err);
  }
}

loadContent();
