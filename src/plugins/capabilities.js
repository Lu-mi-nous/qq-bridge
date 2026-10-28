// 每个 Host 独立持有的能力表；不加载实现，不作为 Node 进程沙箱。
export function createCapabilityRegistry({ isAvailable = () => false } = {}) {
  const entries = new Map();
  const get = name => {
    const entry = entries.get(String(name));
    return entry && isAvailable(entry.owner) ? entry.value : null;
  };
  const reader = Object.freeze({
    get,
    has: name => get(name) !== null,
    list: () => [...entries].filter(([, e]) => isAvailable(e.owner))
      .map(([name, e]) => ({ name, owner: e.owner }))
  });
  function scope(owner) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(owner)) throw new Error('Invalid capability owner');
    let closed = false;
    function provide(name, value) {
      name = String(name);
      if (closed) throw new Error(`Capability scope closed: ${owner}`);
      if (!name.startsWith(`${owner}.`) || !/^[a-z0-9.-]+$/.test(name)
          || name.endsWith('.') || name.includes('..')) throw new Error(`Invalid capability namespace: ${name}`);
      if (value == null) throw new TypeError('Capability value must not be null');
      if (entries.has(name)) throw new Error(`Duplicate capability: ${name}`);
      const entry = { owner, value };
      entries.set(name, entry);
      return () => { if (entries.get(name) === entry) entries.delete(name); };
    }
    return {
      api: Object.freeze({ ...reader, provide }),
      close() {
        if (closed) return;
        closed = true;
        for (const [name, entry] of entries) if (entry.owner === owner) entries.delete(name);
      }
    };
  }
  return { reader, scope };
}
