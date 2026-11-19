-- Portfolio analytics v1.2 — proxy / hosting exit detection.
-- Cloudflare 边缘提供的粗粒度网络归属（ASN + 运营商名），用于识别
-- WARP / 云厂商 / VPN 出口：这类访问的「国家/城市」只是节点所在地。
-- 仍然不存原始 IP、不写日志。
ALTER TABLE events ADD COLUMN asn INTEGER;
ALTER TABLE events ADD COLUMN as_org TEXT;
