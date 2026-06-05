#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Dev static server for Tauri (port 1420).
#
# Sends no-store headers and never returns 304 so the macOS WebView does not
# keep stale ES modules between edits (agent.js, panel layout, etc.).

from __future__ import annotations

import argparse
import http.server
import os
import sys
from http import HTTPStatus


class DevHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    """Serve src/ with cache disabled for local Tauri WebKit."""

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_head(self):
        """Always return the full file body (skip 304 Not Modified)."""
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            if not self.path.endswith("/"):
                self.send_response(HTTPStatus.MOVED_PERMANENTLY)
                self.send_header("Location", self.path + "/")
                self.end_headers()
                return None
            for index in ("index.html", "index.htm"):
                index_path = os.path.join(path, index)
                if os.path.exists(index_path):
                    path = index_path
                    break
            else:
                return self.list_directory(path)

        ctype = self.guess_type(path)
        try:
            file_obj = open(path, "rb")
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None

        try:
            fs = os.fstat(file_obj.fileno())
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-type", ctype)
            self.send_header("Content-Length", str(fs.st_size))
            self.send_header("Last-Modified", self.date_time_string(fs.st_mtime))
            self.end_headers()
            return file_obj
        except Exception:
            file_obj.close()
            raise

    def log_message(self, format: str, *args) -> None:
        sys.stderr.write("[dev-server] %s - %s\n" % (self.address_string(), format % args))


def main() -> int:
    parser = argparse.ArgumentParser(description="LLIMEdit dev static server")
    parser.add_argument("--directory", required=True, help="Directory to serve (src/)")
    parser.add_argument("--port", type=int, default=1420)
    parser.add_argument("--bind", default="127.0.0.1")
    args = parser.parse_args()

    root = os.path.abspath(args.directory)
    os.chdir(root)
    server = http.server.ThreadingHTTPServer(
        (args.bind, args.port),
        DevHTTPRequestHandler,
    )
    sys.stderr.write(
        "LLIMEdit dev server: serving %s (Cache-Control: no-store, no 304)\n" % root
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("\n[dev-server] stopped\n")
        return 0
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
