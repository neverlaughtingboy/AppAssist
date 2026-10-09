// Usage:
// #sub-store-file-name=file-a,file-b&proxy-provider-url=https%3A%2F%2Fexample.com%2Fsurge.conf&proxy-provider-user-agent=Surge%20Mac&proxy-exclude=🇸🇬|新加坡|坡|狮城|SG|Singapore&proxy-domain-dns-detect=true
//
// Read Surge confs from the Sub-Store files named by the comma-separated
// `sub-store-file-name` (a file that fails to read is skipped with a log;
// when every file fails, fall back to downloading `proxy-provider-url`, with
// which `proxy-provider-user-agent` pairs). Merge the sources and fill the
// Surge module template in the current file with the node DNS helpers
// migrated out of template.js:
//   [General] always-real-ip = %APPEND% <encrypted DNS server domains>
//   [Rule]    DOMAIN,<dns server domain>,DIRECT per DNS server domain (IPs
//             are skipped)
//   [Host]    <node domain> = server:<merged DNS server list>; every domain
//             gets the full list, or only the DoH servers that resolved it
//             when proxy-domain-dns-detect is on
//
// The script owns the generated shapes: on each run every DOMAIN,*,DIRECT
// rule, every `= server:` host mapping and the whole always-real-ip value
// after %APPEND% are removed and rewritten, so keep manual entries in other
// shapes (DOMAIN-SUFFIX rules, static IP host mappings) or other files.
//
// `proxy-provider-url` only works with an address the backend can fetch
// directly: a standalone Sub-Store backend or e.g. a raw.githubusercontent.com
// link. Sub-Store embedded in a Surge/Loon module only answers sub.store
// requests that the module intercepts, which script downloads bypass, so use
// `sub-store-file-name` there.

log('Start')

// markers written by earlier script versions, stripped when rewriting
const LEGACY_MANAGED_BEGIN = '# sub-store-managed-begin'
const LEGACY_MANAGED_END = '# sub-store-managed-end'

const args = $arguments || {}
const subStoreFileNames = getCommaValues(args['sub-store-file-name'] ?? args.subStoreFileName ?? '')
const proxyProviderUrl = args['proxy-provider-url'] ?? args.proxyProviderUrl
const proxyProviderUserAgent =
  args['proxy-provider-user-agent'] ?? args.proxyProviderUserAgent ??
  args['proxy-provider-ua'] ?? args.proxyProviderUa
const proxyExclude = args['proxy-exclude'] ?? args.proxyExclude
const proxyDomainDnsDetect =
  args['proxy-domain-dns-detect'] ?? args.proxyDomainDnsDetect
const proxyDomainDnsDetectTimeout =
  args['proxy-domain-dns-detect-timeout'] ?? args.proxyDomainDnsDetectTimeout
const proxyDomainDnsDetectConcurrency =
  args['proxy-domain-dns-detect-concurrency'] ?? args.proxyDomainDnsDetectConcurrency

if (subStoreFileNames.length === 0 && !proxyProviderUrl) {
  throw new Error('Missing required argument: sub-store-file-name or proxy-provider-url')
}

const currentContent = $content ?? $files?.[0]
if (typeof currentContent !== 'string' || !currentContent.trim()) {
  throw new Error('Current module template is empty or unavailable')
}

const targetContents = await loadTargetContents(subStoreFileNames, proxyProviderUrl, proxyProviderUserAgent)
if (targetContents.length === 0) {
  throw new Error('No target Surge conf could be read')
}

const proxies = []
const dnsServerValues = []
for (const targetContent of targetContents) {
  const target = splitContent(targetContent)
  proxies.push(...getProxyEntries(target.lines))
  dnsServerValues.push(...getCommaValues(getConfigValue(target.lines, 'encrypted-dns-server')))
}
const encryptedDnsServers = unique(dnsServerValues)
if (encryptedDnsServers.length === 0) {
  throw new Error('Target file does not contain encrypted-dns-server')
}
log(`Found ${encryptedDnsServers.length} encrypted DNS server(s) from ${targetContents.length} source(s)`)

const filteredProxies = excludeProxies(proxies, proxyExclude)
const hostDomains = unique(
  filteredProxies
    .map(proxy => extractProxyDomain(proxy.value))
    .filter(Boolean)
    .map(domain => domain.toLowerCase())
)
log(`Found ${hostDomains.length} node domain(s)`)

const hostDnsServers = await resolveHostDnsServers(hostDomains, encryptedDnsServers, {
  detect: isTrue(proxyDomainDnsDetect),
  timeout: parsePositiveInteger(proxyDomainDnsDetectTimeout, 2000),
  concurrency: parsePositiveInteger(proxyDomainDnsDetectConcurrency, 5),
})

const dnsServerDomains = unique(
  encryptedDnsServers
    .map(server => extractDnsServerDomain(server))
    .filter(Boolean)
)

const current = splitContent(currentContent)
log(`Write ${dnsServerDomains.length} DNS server direct rule(s) into [Rule]`)
rewriteDirectRules(current.lines, dnsServerDomains.map(domain => `DOMAIN,${domain},DIRECT`))

log(`Write ${hostDnsServers.size} node Host rule(s) into [Host]`)
rewriteHostRules(
  current.lines,
  [...hostDnsServers].map(([domain, dnsServers]) => `${domain} = server:${dnsServers.join(',')}`)
)

log(`Append ${dnsServerDomains.length} DNS server domain(s) to always-real-ip`)
upsertAlwaysRealIpAppend(current.lines, dnsServerDomains)

$content = current.lines.join(current.eol)

log('End')

async function loadTargetContents(fileNames, providerUrl, userAgent) {
  const url = String(providerUrl ?? '').trim()
  const contents = []

  for (const fileName of fileNames) {
    log(`Read target Surge conf file: ${fileName}`)
    try {
      const content = await produceArtifact({
        type: 'file',
        name: fileName,
      })
      if (String(content ?? '').trim()) {
        contents.push(String(content))
        continue
      }
      log(`Sub-Store file [${fileName}] is empty`)
    } catch (e) {
      log(`Read target Surge conf file [${fileName}] failed: ${e.message ?? e}`)
    }
  }

  if (contents.length > 0) return contents

  if (url) {
    if (fileNames.length > 0) {
      log('Every sub-store-file-name failed, fall back to proxy-provider-url')
    }
    log(`Read target Surge conf from proxy-provider-url: ${maskUrl(url)}`)
    if (String(userAgent ?? '').trim()) {
      log('Use custom proxy-provider-user-agent')
    }
    try {
      return [await downloadText(url, userAgent, 'proxy-provider-url')]
    } catch (e) {
      log(`Download proxy-provider-url failed: ${e.message ?? e}`)
    }
  }

  return []
}

async function downloadText(url, userAgent, label) {
  const downloader =
    typeof ProxyUtils !== 'undefined' && typeof ProxyUtils?.download === 'function'
      ? ProxyUtils.download
      : typeof download === 'function'
        ? download
        : null

  if (!downloader) {
    throw new Error(`${label} requires ProxyUtils.download, but it is unavailable`)
  }

  const ua = String(userAgent ?? '').trim() || undefined
  const result = await downloader(url, ua, undefined, undefined, undefined, undefined, true)
  if (typeof result === 'string') return result
  if (result && typeof result.body === 'string') return result.body
  return String(result ?? '')
}

function rewriteDirectRules(lines, newLines) {
  const bounds = ensureSection(lines, 'Rule')
  for (let index = bounds.end - 1; index > bounds.start; index--) {
    const trimmed = lines[index].trim()
    if (
      trimmed === LEGACY_MANAGED_BEGIN ||
      trimmed === LEGACY_MANAGED_END ||
      /^DOMAIN,[^,]+,DIRECT$/i.test(trimmed)
    ) {
      lines.splice(index, 1)
    }
  }
  if (newLines.length > 0) {
    lines.splice(bounds.start + 1, 0, ...newLines)
  }
}

function rewriteHostRules(lines, newLines) {
  const bounds = ensureSection(lines, 'Host')
  for (let index = bounds.end - 1; index > bounds.start; index--) {
    const trimmed = lines[index].trim()
    if (trimmed === LEGACY_MANAGED_BEGIN || trimmed === LEGACY_MANAGED_END) {
      lines.splice(index, 1)
      continue
    }
    const parsed = parseKeyValueLine(lines[index])
    if (parsed && /^server:/i.test(parsed.value)) {
      lines.splice(index, 1)
    }
  }
  if (newLines.length > 0) {
    lines.splice(bounds.start + 1, 0, ...newLines)
  }
}

function upsertAlwaysRealIpAppend(lines, domains) {
  const bounds = ensureSection(lines, 'General')
  for (let index = bounds.start + 1; index < bounds.end; index++) {
    const parsed = parseKeyValueLine(lines[index])
    if (!parsed || parsed.key.toLowerCase() !== 'always-real-ip') continue

    // module semantics: %APPEND% extends the profile value instead of
    // replacing it, and the list is regenerated from the current servers
    const value = domains.length > 0 ? `%APPEND% ${domains.join(', ')}` : '%APPEND%'
    lines[index] = `${parsed.indent}${parsed.key} = ${value}`
    return
  }

  if (domains.length === 0) return
  insertSectionLines(lines, 'General', [`always-real-ip = %APPEND% ${domains.join(', ')}`])
}

function excludeProxies(proxies, pattern) {
  if (!pattern) {
    log(`proxy-exclude is empty, keep all ${proxies.length} proxy/proxies`)
    return proxies
  }

  const regex = createExcludeRegExp(pattern)
  const filtered = proxies.filter(proxy => !regex.test(proxy.name))
  log(`proxy-exclude ${regex} removed ${proxies.length - filtered.length}/${proxies.length} proxy/proxies`)
  return filtered
}

async function resolveHostDnsServers(domains, dnsServers, options) {
  const defaultDnsServer = dnsServers[0]
  const results = new Map()
  if (domains.length === 0) return results

  const dohServers = unique(dnsServers.filter(isDohServer))
  const shouldDetect =
    options.detect &&
    dohServers.length > 0 &&
    typeof ProxyUtils !== 'undefined' &&
    typeof ProxyUtils?.doh === 'function'

  if (!shouldDetect) {
    if (options.detect && dohServers.length > 0) {
      log('ProxyUtils.doh is unavailable, use all encrypted-dns-server for host DNS rules')
    } else {
      log(`Use all ${dnsServers.length} encrypted-dns-server(s) for host DNS rules`)
    }
    domains.forEach(domain => results.set(domain, dnsServers))
    return results
  }

  log(
    `Detect DoH availability for ${domains.length} domain(s), ${dohServers.length} DoH server(s), concurrency ${options.concurrency}, timeout ${options.timeout}ms`
  )

  const cache = new Map()
  const checks = await mapWithConcurrency(
    domains.flatMap(domain => dohServers.map(dnsServer => ({ domain, dnsServer }))),
    options.concurrency,
    async ({ domain, dnsServer }) => ({
      domain,
      dnsServer,
      available: await canResolveDomainWithDoh(domain, dnsServer, {
        timeout: options.timeout,
        cache,
      }),
    })
  )

  const availableByDomain = new Map(domains.map(domain => [domain, []]))
  for (const check of checks) {
    if (check.available) {
      availableByDomain.get(check.domain).push(check.dnsServer)
    }
  }

  for (const domain of domains) {
    const availableDnsServers = availableByDomain.get(domain)

    if (availableDnsServers.length === 0) {
      log(`No DoH server resolved ${domain}, fallback to first encrypted-dns-server`)
      results.set(domain, [defaultDnsServer])
    } else {
      results.set(domain, availableDnsServers)
    }
  }

  return results
}

async function canResolveDomainWithDoh(domain, dnsServer, options) {
  const key = `${dnsServer}|${domain}`
  if (options.cache.has(key)) return options.cache.get(key)

  const types = ['A', 'AAAA']
  let lastError = ''
  for (const type of types) {
    try {
      const response = await ProxyUtils.doh({
        url: dnsServer,
        domain,
        type,
        timeout: options.timeout,
      })
      if (hasDnsAnswer(response)) {
        options.cache.set(key, true)
        return true
      }
    } catch (e) {
      lastError = e.message ?? String(e)
    }
  }

  if (lastError) {
    log(`DoH ${dnsServer} failed to resolve ${domain}: ${lastError}`)
  }
  options.cache.set(key, false)
  return false
}

function hasDnsAnswer(response) {
  return Array.isArray(response?.answers) &&
    response.answers.some(answer => {
      const type = String(answer?.type ?? '').toUpperCase()
      return (type === 'A' || type === 'AAAA') && Boolean(answer?.data)
    })
}

function isDohServer(value) {
  return /^https?:\/\//i.test(String(value || '').trim())
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length)
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(concurrency, values.length))

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++
        results[index] = await mapper(values[index], index)
      }
    })
  )

  return results
}

function getProxyEntries(lines) {
  const bounds = getSectionBounds(lines, 'Proxy')
  if (!bounds) return []

  const proxies = []
  for (let index = bounds.start + 1; index < bounds.end; index++) {
    const parsed = parseKeyValueLine(lines[index])
    if (!parsed) continue
    if (!parsed.value) continue
    proxies.push({
      name: parsed.key,
      value: parsed.value,
    })
  }
  return proxies
}

function extractProxyDomain(value) {
  const tokens = splitCommaValues(value).map(token => token.trim()).filter(Boolean)
  if (tokens.length < 2) return ''

  const protocol = stripQuotes(tokens[0]).trim().toLowerCase()
  if (/^(direct|reject|reject-drop|reject-tinygif)$/i.test(protocol)) return ''

  let server = tokens[1]
  const keyValueServer = tokens.find(token => /^(server|host|hostname)\s*=/i.test(token.trim()))
  if (/^\w[\w-]*\s*=/.test(server) && keyValueServer) {
    server = keyValueServer.replace(/^[^=]+=/, '')
  }

  server = normalizeDomain(server)
  return isValidDomain(server) ? server : ''
}

function extractDnsServerDomain(value) {
  const withoutScheme = stripQuotes(String(value ?? '').trim()).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const host = withoutScheme.split(/[/?#]/)[0]
  const domain = normalizeDomain(host.split(':')[0])
  return isValidDomain(domain) ? domain.toLowerCase() : ''
}

function normalizeDomain(value) {
  let domain = stripQuotes(String(value || '').trim())
  domain = domain.replace(/^\[/, '').replace(/\]$/, '')
  domain = domain.replace(/\.$/, '')
  return domain
}

function isValidDomain(domain) {
  if (!domain) return false
  if (domain.length > 253) return false
  if (typeof ProxyUtils !== 'undefined' && ProxyUtils?.isIP?.(domain)) return false
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(domain)) return false
  if (/[:/?#@*_\s]/.test(domain)) return false
  if (!domain.includes('.')) return false

  return domain
    .split('.')
    .every(label =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)
    )
}

function getConfigValue(lines, key) {
  const keyLower = key.toLowerCase()
  for (const line of lines) {
    const parsed = parseKeyValueLine(line)
    if (!parsed) continue
    if (parsed.key.toLowerCase() === keyLower) return parsed.value
  }
  return ''
}

function getCommaValues(value) {
  return splitCommaValues(String(value ?? ''))
    .map(token => stripQuotes(token).trim())
    .filter(Boolean)
}

function createExcludeRegExp(pattern) {
  const source = String(pattern || '.*')
  const cleanSource = source.split('ℹ️').join('')
  return new RegExp(cleanSource || '.*', 'i')
}

function insertSectionLines(lines, sectionName, additions) {
  if (!additions.length) return
  const bounds = ensureSection(lines, sectionName)
  const insertAt = getSectionInsertIndex(lines, bounds)
  lines.splice(insertAt, 0, ...additions)
}

function getSectionInsertIndex(lines, bounds) {
  let index = bounds.end
  while (index > bounds.start + 1 && lines[index - 1].trim() === '') {
    index--
  }
  return index
}

function ensureSection(lines, sectionName) {
  const bounds = getSectionBounds(lines, sectionName)
  if (bounds) return bounds

  if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
    lines.push('')
  }
  lines.push(`[${sectionName}]`)
  return {
    start: lines.length - 1,
    end: lines.length,
  }
}

function getSectionBounds(lines, sectionName) {
  const expected = sectionName.toLowerCase()
  let start = -1

  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/)
    if (!match) continue
    if (match[1].trim().toLowerCase() === expected) {
      start = index
      break
    }
  }

  if (start === -1) return null

  let end = lines.length
  for (let index = start + 1; index < lines.length; index++) {
    if (/^\s*\[[^\]]+\]\s*(?:[#;].*)?$/.test(lines[index])) {
      end = index
      break
    }
  }

  return { start, end }
}

function parseKeyValueLine(line) {
  if (!line || /^\s*[#;]/.test(line)) return null

  const { body, comment } = splitInlineComment(line)
  const equalIndex = body.indexOf('=')
  if (equalIndex < 0) return null

  const indent = body.match(/^\s*/)?.[0] || ''
  const key = body.slice(0, equalIndex).trim()
  const value = body.slice(equalIndex + 1).trim()
  if (!key) return null

  return { indent, key, value, comment }
}

function splitInlineComment(line) {
  let quote = ''
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (quote) {
      if (char === '\\') {
        index++
      } else if (char === quote) {
        quote = ''
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if ((char === '#' || char === ';') && (index === 0 || /\s/.test(line[index - 1]))) {
      return {
        body: line.slice(0, index).trimEnd(),
        comment: line.slice(index).trim(),
      }
    }
  }

  return { body: line.trimEnd(), comment: '' }
}

function splitCommaValues(value) {
  const result = []
  let current = ''
  let quote = ''
  let depth = 0

  for (let index = 0; index < value.length; index++) {
    const char = value[index]

    if (quote) {
      current += char
      if (char === '\\') {
        index++
        current += value[index] || ''
      } else if (char === quote) {
        quote = ''
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }

    if (char === '[' || char === '(' || char === '{') {
      depth++
    } else if (char === ']' || char === ')' || char === '}') {
      depth = Math.max(0, depth - 1)
    }

    if (char === ',' && depth === 0) {
      result.push(current)
      current = ''
      continue
    }

    current += char
  }

  result.push(current)
  return result
}

function splitContent(content) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  return {
    eol,
    lines: content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n'),
  }
}

function stripQuotes(value) {
  const text = String(value || '').trim()
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1)
  }
  return text
}

function unique(values) {
  return [...new Set(values)]
}

function isTrue(value) {
  return /^(true|1|yes|on)$/i.test(String(value ?? '').trim())
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function maskUrl(value) {
  const text = String(value || '')
  try {
    const url = new URL(text)
    return `${url.protocol}//${url.host}${url.pathname ? '/***' : ''}`
  } catch {
    return text.replace(/([?&][^=]*?(?:token|key|secret|password|passwd|pwd|auth)[^=]*=)[^&#]+/gi, '$1***')
  }
}

function log(message) {
  console.log(`[Surge module] ${message}`)
}
