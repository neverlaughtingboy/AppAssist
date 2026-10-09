// Usage:
// #url=https%3A%2F%2Fexample.com%2Fsubscription.conf
// #sub-store-file-name=sub-file
//
// Read the Loon subscription config from the Sub-Store file named by
// `sub-store-file-name` first, falling back to `url` when the file read fails
// or `sub-store-file-name` has no value (`user-agent` pairs with `url`). `url`
// only works with an address the backend can fetch directly: a standalone
// Sub-Store backend or a raw file link. Sub-Store embedded in a Surge/Loon
// module only answers sub.store requests that the module intercepts, which
// script downloads bypass, so use `sub-store-file-name` there.
//
// Extract the doh-server list from [General] and the server domain of every
// [Proxy] entry, then fill the Loon plugin template in the current file:
//   [Rule]  one DOMAIN,<domain>,DIRECT rule per DoH server domain (IPs skipped)
//   [Host]  <domain> = server:<full doh-server list> for every deduped node
//           domain. A node domain that already has a domain-to-domain Host
//           mapping contributes its mapped domain instead (a.com = b.com
//           produces a rule for b.com); mappings to servers or IPs are kept
//           untouched. The same respect applies to [Rule]: a domain with an
//           existing DOMAIN rule is not touched.

log('Start')

const args = $arguments || {}
const providerUrl =
  args.url ?? args['provider-url'] ?? args['proxy-provider-url'] ??
  args.providerUrl ?? args.proxyProviderUrl
const providerUserAgent =
  args['user-agent'] ?? args.userAgent ??
  args['proxy-provider-user-agent'] ?? args.proxyProviderUserAgent
const providerFileName =
  args['sub-store-file-name'] ?? args.subStoreFileName

if (!providerUrl && !providerFileName) {
  throw new Error('Missing required argument: url or sub-store-file-name')
}

const currentContent = $content ?? $files?.[0]
if (typeof currentContent !== 'string' || !currentContent.trim()) {
  throw new Error('Current plugin template is empty or unavailable')
}

const confContent = await loadConfContent(providerUrl, providerFileName, providerUserAgent)
if (!confContent.trim()) {
  throw new Error('Subscription config content is empty')
}

const conf = splitContent(confContent)

const dnsServers = getDnsServers(conf.lines)
if (dnsServers.length === 0) {
  throw new Error(`Subscription config has no usable doh-server in [General]: ${describeDnsServerIssue(conf.lines)}`)
}
log(`Found ${dnsServers.length} DNS server(s): ${dnsServers.join(', ')}`)

const dnsServerDomains = unique(
  dnsServers.map(server => extractDnsServerDomain(server)).filter(Boolean)
)

const nodeDomains = unique(
  getProxyEntries(conf.lines)
    .map(proxy => extractProxyDomain(proxy.value))
    .filter(Boolean)
    .map(domain => domain.toLowerCase())
)
log(`Found ${nodeDomains.length} node domain(s)`)

const current = splitContent(currentContent)
appendDirectRules(current.lines, dnsServerDomains)
appendHostRules(current.lines, nodeDomains, dnsServers)

$content = current.lines.join(current.eol)

log('End')

async function loadConfContent(url, fileName, userAgent) {
  if (fileName) {
    log(`Read subscription config file: ${fileName}`)
    try {
      const content = await produceArtifact({
        type: 'file',
        name: fileName,
      })
      if (String(content ?? '').trim()) return content
      log(`Sub-Store file [${fileName}] is empty`)
    } catch (e) {
      log(`Read subscription config file [${fileName}] failed: ${e.message ?? e}`)
    }
    if (!url) return ''
    log('Fall back to url')
  }

  const ua = String(userAgent ?? '').trim() || undefined
  log(`Read subscription config from url: ${maskUrl(String(url))}${ua ? ` (User-Agent: ${ua})` : ''}`)
  return await downloadText(url, ua, 'url')
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

function getDnsServers(lines) {
  return getCommaValues(getConfigValueInSection(lines, 'General', 'doh-server')).filter(isServerValue)
}

function describeDnsServerIssue(lines) {
  if (!getSectionBounds(lines, 'General')) {
    const firstLine = (lines.find(line => line.trim()) || '(empty)').trim()
    if (firstLine.startsWith('<')) {
      return `the fetched content is an HTML page (first line: ${firstLine.slice(0, 80)}); the url points to a web frontend such as sub.store instead of the Sub-Store backend — use the backend address or the name argument`
    }
    return `no [General] section in the fetched content (first line: ${firstLine.slice(0, 80)}); the source is not a Loon config, prefer the name argument or check the url content`
  }

  const raw = getConfigValueInSection(lines, 'General', 'doh-server')
  if (!raw) {
    return '[General] exists but contains no doh-server line'
  }
  return `doh-server found but every value was filtered out (${getCommaValues(raw).join(', ')})`
}

function getConfigValueInSection(lines, sectionName, key) {
  const bounds = getSectionBounds(lines, sectionName)
  if (!bounds) return ''

  const keyLower = key.toLowerCase()
  for (let index = bounds.start + 1; index < bounds.end; index++) {
    const parsed = parseKeyValueLine(lines[index])
    if (parsed && parsed.key.toLowerCase() === keyLower) return parsed.value
  }
  return ''
}

function isServerValue(value) {
  const text = stripQuotes(String(value ?? '').trim())
  if (!text) return false
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || text.includes('.')
}

function appendDirectRules(lines, domains) {
  const existing = getExistingDomainRuleDomains(lines)
  const missing = domains.filter(domain => !existing.has(domain))
  if (missing.length === 0) {
    log('No new DNS server direct rule to append')
    return
  }

  // rules match top-down, so the direct rules go right below the [Rule] header
  const bounds = ensureSection(lines, 'Rule')
  lines.splice(bounds.start + 1, 0, ...missing.map(domain => `DOMAIN,${domain},DIRECT`))
  log(`Append ${missing.length} DNS server direct rule(s)`)
}

function getExistingDomainRuleDomains(lines) {
  const domains = new Set()
  const bounds = getSectionBounds(lines, 'Rule')
  if (!bounds) return domains

  for (let index = bounds.start + 1; index < bounds.end; index++) {
    const rule = parseRuleLine(lines[index])
    if (rule && rule.type === 'DOMAIN') domains.add(rule.value.toLowerCase())
  }
  return domains
}

function appendHostRules(lines, domains, dnsServers) {
  const bounds = ensureSection(lines, 'Host')
  const existingValues = new Map()
  for (let index = bounds.start + 1; index < bounds.end; index++) {
    const parsed = parseKeyValueLine(lines[index])
    if (!parsed) continue
    existingValues.set(parsed.key.toLowerCase(), parsed.value)
  }

  // a.com = b.com style alias: the mapped domain is the one actually resolved,
  // so the DNS rule targets b.com instead of a.com
  const targets = []
  let aliased = 0
  let skipped = 0
  for (const domain of domains) {
    const existing = existingValues.get(domain)
    if (existing === undefined) {
      targets.push(domain)
      continue
    }

    const mapped = normalizeDomain(existing)
    if (isValidDomain(mapped)) {
      aliased++
      targets.push(mapped.toLowerCase())
    } else {
      skipped++
    }
  }

  const claimed = new Set(existingValues.keys())
  const newLines = []
  for (const target of targets) {
    if (claimed.has(target)) continue
    claimed.add(target)
    newLines.push(`${target} = server:${dnsServers.join(',')}`)
  }

  if (aliased > 0) {
    log(`Follow ${aliased} node domain alias(es) to the mapped domain`)
  }
  if (skipped > 0) {
    log(`Skip ${skipped} node domain(s) that already have a server or IP mapping`)
  }
  if (newLines.length > 0) {
    insertSectionLines(lines, 'Host', newLines)
    log(`Append ${newLines.length} node Host rule(s)`)
  } else {
    log('No node Host rule to append')
  }
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

function parseRuleLine(line) {
  if (!line || /^\s*[#;]/.test(line)) return null

  const { body } = splitInlineComment(line)
  const parts = splitCommaValues(body).map(part => part.trim()).filter(Boolean)
  if (parts.length < 2 || !parts[0]) return null

  return { type: parts[0].toUpperCase(), value: parts[1] }
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

function getCommaValues(value) {
  return splitCommaValues(String(value ?? ''))
    .map(token => stripQuotes(token).trim())
    .filter(Boolean)
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
  console.log(`[Loon template] ${message}`)
}
