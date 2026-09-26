# Logging

The library uses **@libp2p/logger** for consistent logging across the libp2p ecosystem. Control logging with the `DEBUG` environment variable:

**Node.js:**
```bash
# Enable all logs from this library (the namespace kept its old name)
DEBUG=libp2p:orbitdb-storacha:* node your-script.js

# Enable specific components
DEBUG=libp2p:orbitdb-storacha:bridge node your-script.js

# Enable all libp2p logs (includes this library + libp2p internals)
DEBUG=libp2p:* node your-script.js
```

**Browser:**
```javascript
// In browser console or before loading the application
localStorage.setItem('debug', 'libp2p:orbitdb-storacha:*')
// Then refresh the page
```

The logger supports printf-style formatting:
- `%s` - string
- `%d` - number
- `%o` - object
- `%p` - peer ID
- `%b` - base58btc encoded data
- `%t` - base32 encoded data
