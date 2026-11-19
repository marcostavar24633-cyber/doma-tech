/* DOMA TECH cinematic motion: restrained reveal + desktop pointer depth */
(() => {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const targets = document.querySelectorAll('.section-heading,.category-card,.market-card,.steps-grid>div,.about>div,.faq>details');
  if (!reduce && 'IntersectionObserver' in window) {
    document.body.classList.add('motion-ready');
    const observer = new IntersectionObserver((entries, current) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        current.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    targets.forEach((target, index) => {
      target.style.transitionDelay = (Math.min(index % 4, 3) * 75) + 'ms';
      observer.observe(target);
    });
  }
  const hero = document.querySelector('.hero');
  const visual = document.querySelector('.hero-photo');
  if (!reduce && hero && visual && window.matchMedia('(pointer:fine)').matches) {
    let frame = 0;
    hero.addEventListener('pointermove', (event) => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = hero.getBoundingClientRect();
        const x = (event.clientX - bounds.left) / bounds.width - 0.5;
        const y = (event.clientY - bounds.top) / bounds.height - 0.5;
        visual.style.transform = 'scale(1.045) translate3d(' + (x * -7).toFixed(2) + 'px,' + (y * -5).toFixed(2) + 'px,0)';
      });
    }, { passive: true });
    hero.addEventListener('pointerleave', () => { visual.style.transform = ''; });
  }
})();
