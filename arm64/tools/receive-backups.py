#!/usr/bin/env python3
"""Receive only original p2/p3 backups from one explicitly selected LAN client."""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import ipaddress
import os
from pathlib import Path

SIZES = {'/original-p2.bin': 4194304, '/original-p3.bin': 12582912}

def store_backup(stream, output, path, length):
    if path not in SIZES or length != SIZES[path]:
        raise ValueError('only exact 4 MiB p2 and 12 MiB p3 uploads are accepted')
    target = Path(output) / path[1:]
    created = False
    try:
        with target.open('xb') as dest:
            created = True
            remaining = length
            while remaining:
                chunk = stream.read(min(65536, remaining))
                if not chunk:
                    raise ValueError('incomplete upload')
                dest.write(chunk)
                remaining -= len(chunk)
            dest.flush()
            os.fsync(dest.fileno())
    except BaseException:
        if created:
            target.unlink(missing_ok=True)
        raise
    with target.open('rb') as data:
        return hashlib.file_digest(data, 'sha256').hexdigest()

def address(value):
    ip = ipaddress.IPv4Address(value)
    if ip.is_unspecified or ip.is_multicast:
        raise argparse.ArgumentTypeError('specify a concrete unicast IPv4 address')
    return str(ip)

class Receiver(HTTPServer):
    def verify_request(self, request, client_address):
        return client_address[0] == self.allowed_client

class Upload(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def do_POST(self):
        try:
            if self.headers.get_all('Transfer-Encoding') or len(self.headers.get_all('Content-Length', [])) != 1:
                raise ValueError('one Content-Length is required; chunked uploads are refused')
            digest = store_backup(self.rfile, self.server.output, self.path, int(self.headers['Content-Length']))
        except (ValueError, OSError) as error:
            self.send_error(400, str(error))
            return
        self.server.received.add(self.path)
        print(f'{digest}  {self.path[1:]}', flush=True)
        payload = (digest + '\n').encode('ascii')
        self.send_response(200)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        pass

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bind', type=address, required=True, help='specific host LAN IPv4; never 0.0.0.0')
    parser.add_argument('--client', type=address, required=True, help='only this TR100 IPv4 may upload')
    parser.add_argument('--port', type=int, default=8001)
    parser.add_argument('--output', type=Path, required=True, help='new private directory; existing paths are refused')
    args = parser.parse_args()
    args.output.mkdir(mode=0o700)
    with Receiver((args.bind, args.port), Upload) as server:
        server.allowed_client = args.client
        server.output = args.output
        server.received = set()
        print(f'Waiting for p2/p3 from {args.client} on {args.bind}:{args.port}', flush=True)
        while server.received != set(SIZES):
            server.handle_request()
    print('Both backups received. Compare the displayed SHA256 with the TTL console before confirming installation.')

if __name__ == '__main__':
    main()
