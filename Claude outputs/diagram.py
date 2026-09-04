import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

W, H = 13.5, 10.8
fig, ax = plt.subplots(figsize=(W, H), dpi=200)
ax.set_xlim(0, W)
ax.set_ylim(0, H)
ax.axis("off")

FILL = "#EAF1FB"
FILL_ALT = "#FDEEDC"
FILL_STORE = "#EAF7EE"
FILL_RES = "#F2E9FB"
FILL_DLQ = "#FBEFEF"
FILL_EXT = "#F2F2F2"
EDGE = "#2E4B6B"
TEXT = "#1B2733"

def box(x, y, w, h, label, fill=FILL, fontsize=9.3, edge=EDGE, weight="bold"):
    b = FancyBboxPatch(
        (x, y), w, h,
        boxstyle="round,pad=0.02,rounding_size=0.08",
        linewidth=1.4, edgecolor=edge, facecolor=fill, zorder=2,
    )
    ax.add_patch(b)
    ax.text(x + w / 2, y + h / 2, label, ha="center", va="center",
             fontsize=fontsize, color=TEXT, weight=weight, zorder=3, linespacing=1.4)
    return (x, y, w, h)

def edge_point(box_, other_center):
    x, y, w, h = box_
    cx, cy = x + w / 2, y + h / 2
    dx, dy = other_center[0] - cx, other_center[1] - cy
    if abs(dx) < 1e-6 and abs(dy) < 1e-6:
        return (cx, cy)
    if abs(dx) * h > abs(dy) * w:
        px = cx + (w / 2 if dx > 0 else -w / 2)
        py = cy + dy * (w / 2) / abs(dx)
    else:
        py = cy + (h / 2 if dy > 0 else -h / 2)
        px = cx + dx * (h / 2) / abs(dy)
    return (px, py)

def arrow(b1, b2, label=None, style="-|>", color=EDGE, ls="solid", lw=1.3,
          rad=0.0, label_pos=0.5, label_dx=0.0, label_dy=0.0, fontsize=7.8):
    x1, y1, w1, h1 = b1
    x2, y2, w2, h2 = b2
    c1 = (x1 + w1 / 2, y1 + h1 / 2)
    c2 = (x2 + w2 / 2, y2 + h2 / 2)
    p1 = edge_point(b1, c2)
    p2 = edge_point(b2, c1)
    fa = FancyArrowPatch(p1, p2, arrowstyle=style, mutation_scale=11,
                          linewidth=lw, color=color, linestyle=ls,
                          connectionstyle=f"arc3,rad={rad}", zorder=1)
    ax.add_patch(fa)
    if label:
        mx = p1[0] + (p2[0] - p1[0]) * label_pos + label_dx
        my = p1[1] + (p2[1] - p1[1]) * label_pos + label_dy
        ax.text(mx, my, label, ha="center", va="center", fontsize=fontsize,
                 color="#3A5170", zorder=4,
                 bbox=dict(boxstyle="round,pad=0.15", fc="white", ec="none", alpha=0.95))

# ---------- rows ----------
frontend = box(0.4, 9.55, 3.1, 0.85, "S3 + CloudFront\n(static frontend hosting)\nmanaged outside this module", fill=FILL_EXT, fontsize=8.3)
browser  = box(4.6, 9.55, 3.3, 0.85, "Requester's Browser\nReact SPA + MSAL (Azure AD)", fill=FILL_ALT)

apigw = box(3.7, 7.9, 4.6, 0.85,
            "API Gateway (HTTP API)\nPOST /dpc/request   GET /dpc/listrequests\nGET /dpc/requests/{id}   POST /dpc/bitbucket/webhook",
            fill=FILL, fontsize=8.0)

reqapi = box(0.9, 6.1, 3.2, 1.0, "main Lambda\n(lambda/handler.py)", fill=FILL)
gitops = box(5.1, 6.1, 3.4, 1.0, "gitops Lambda\n(lambda-gitops/handler.py)", fill=FILL, fontsize=9.0)

ddb       = box(0.4, 4.1, 2.9, 0.85, "DynamoDB\nrequests table", fill=FILL_STORE)
secrets   = box(4.4, 4.1, 2.5, 0.85, "Secrets Manager\n(Bitbucket token, existing)", fill=FILL_STORE, fontsize=8.0)
bitbucket = box(9.3, 6.1, 3.8, 1.0, "Bitbucket Server\nconfig repo (dev / qa / master)", fill=FILL_ALT, fontsize=8.6)

eventbridge = box(0.4, 1.9, 2.9, 0.9, "EventBridge rule\ngitops_sweep\n(every 10 min)", fill=FILL_RES, fontsize=8.1)
ses         = box(4.15, 1.9, 2.5, 0.8, "SES\nnotifications", fill=FILL_STORE, fontsize=8.4)
dlq         = box(9.3, 4.1, 3.8, 0.9, "SQS DLQ (optional)\nenable_gitops_dlq = true", fill=FILL_DLQ, fontsize=8.4)

# ---------- arrows ----------
arrow(frontend, browser, label="serves SPA")
arrow(browser, apigw, label="HTTPS + Bearer token")
arrow(apigw, reqapi, label="AWS_PROXY\n(all 4 routes)", rad=0.05, label_dx=-0.15)
arrow(bitbucket, apigw, label="webhook events:\npr:opened / merged /\ndeclined / reviewer:*\n(POST /dpc/bitbucket/webhook)",
      ls="dashed", color="#8A5A00", rad=0.35, label_pos=0.5, label_dx=2.35, label_dy=0.95, fontsize=7.6)
arrow(reqapi, gitops, label="async invoke:\nCREATE_PR / PROMOTE", rad=0.0, label_dy=0.24, fontsize=7.6)
arrow(reqapi, ddb, label="Get/Put/Update/Query")
arrow(gitops, secrets, label="GetSecretValue", rad=-0.15, label_dx=0.55, label_dy=-0.05)
arrow(gitops, bitbucket, label="branch / commit / PR\n(REST API calls)", rad=0.0, label_dy=0.28, fontsize=7.6)
arrow(gitops, ses, label="approver + requester\nemail notifications", rad=-0.22, label_dx=0.75, label_dy=-0.15, fontsize=7.4)
arrow(eventbridge, gitops, label="action: SWEEP\n(retries stuck syncs / locks)", rad=-0.18, label_pos=0.18, label_dx=0.55, label_dy=0.15, fontsize=7.4)
arrow(gitops, dlq, label="on-failure destination\n(all retries exhausted)", ls="dashed", color="#8A2D2D", rad=-0.1, label_dx=-0.35, label_dy=0.55, fontsize=7.4)

ax.text(W / 2, 10.45, "DPC Self-Service Whitelisting Portal — Org / Bitbucket Stack", ha="center",
        fontsize=14.5, weight="bold", color="#12233F")

plt.savefig("/tmp/portal_doc/architecture.png", facecolor="white", pad_inches=0.15)
print("done")
