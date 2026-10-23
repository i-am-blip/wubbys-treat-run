// Lightweight analytics. No provider is wired up yet: events are queued on window.wubbyEvents
// (and logged on localhost). To connect one, forward events in send(), e.g.
//   window.gtag && window.gtag('event', name, props);
//   window.plausible && window.plausible(name, { props });
const analytics = {
    send(name, props) { }
};

function track(name, props = {}) {
    try {
        (window.wubbyEvents = window.wubbyEvents || []).push({ name, props, time: Date.now() });
        analytics.send(name, props);
        if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') console.debug('[track]', name, props);
    } catch (e) {
        // Analytics must never break the game
    }
}
