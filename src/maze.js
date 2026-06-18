// Maze generation + solution pathfinding — a faithful port of maze_module.c.
//
// The grid is (2N+1)×(2M+1): odd/odd cells are rooms, the cells between them
// are walls that get carved out. `wall[i][j]` is 1 for a standing wall, 0 for
// open floor. `next[i][j]` is the BFS predecessor toward the exit, so chasing
// `next` from any open cell walks the solution path out.
//
// Index convention matches the C: the first index `i` is the row (world Z),
// the second `j` is the column (world X). Two task "directions" still carry the
// original up/down/left/right names; they're just the four grid neighbours.

const DIR_INIT = 0, DIR_LEFT = 1, DIR_UP = 2, DIR_RIGHT = 3, DIR_DOWN = 4;
const TYPE_NORMAL = 0, TYPE_REVERSE = 1, TYPE_BACKWARD = 2;

export class Maze {
  constructor() {
    this.N = 10;
    this.M = 10;
    this.p = 0.5; // chance to pick a fresh direction at each step (twistiness)
    this.q = 0.5; // chance to spawn an extra branch at each step (branchiness)
  }

  get n() { return 2 * this.N + 1; }
  get m() { return 2 * this.M + 1; }

  generate(N = this.N, M = this.M, p = this.p, q = this.q) {
    this.N = N; this.M = M; this.p = p; this.q = q;
    const n = this.n, m = this.m;

    this.wall = Array.from({ length: n }, () => new Int8Array(m).fill(1));
    this.next = Array.from({ length: n }, () => new Array(m).fill(null));

    this._first = null;
    while (this._notFull()) {
      while (this._first) this._completeTasks(true);
    }
    this._computePaths();
  }

  // --- task list (prepend; iterate one pass, safe against in-pass deletion) ---
  _addTask(posx, posy, dir) {
    const t = { posx, posy, dir, next: this._first };
    this._first = t;
    return t;
  }

  _delTask(t) {
    if (this._first === t) { this._first = t.next; return; }
    let tmp = this._first;
    while (tmp && tmp.next !== t) tmp = tmp.next;
    if (tmp) tmp.next = t.next;
  }

  _move(t) {
    const w = this.wall;
    switch (t.dir) {
      case DIR_UP: w[t.posx][t.posy - 1] = 0; w[t.posx][t.posy -= 2] = 0; break;
      case DIR_DOWN: w[t.posx][t.posy + 1] = 0; w[t.posx][t.posy += 2] = 0; break;
      case DIR_LEFT: w[t.posx - 1][t.posy] = 0; w[t.posx -= 2][t.posy] = 0; break;
      case DIR_RIGHT: w[t.posx + 1][t.posy] = 0; w[t.posx += 2][t.posy] = 0; break;
    }
  }

  _getMoves(t, type) {
    const w = this.wall, next = this.next, n = this.n, m = this.m;
    const moves = [];
    if (type === TYPE_BACKWARD) {
      if (!w[t.posx][t.posy - 1] && !next[t.posx][t.posy - 1]) moves.push(DIR_UP);
      if (!w[t.posx][t.posy + 1] && !next[t.posx][t.posy + 1]) moves.push(DIR_DOWN);
      if (!w[t.posx - 1][t.posy] && !next[t.posx - 1][t.posy]) moves.push(DIR_LEFT);
      if (!w[t.posx + 1][t.posy] && !next[t.posx + 1][t.posy]) moves.push(DIR_RIGHT);
    } else {
      const norm = type === TYPE_NORMAL;
      if (t.posy > 1 && (type ^ w[t.posx][t.posy - 2]) &&
        (norm || !(t.posx === n - 2 && t.posy === m))) moves.push(DIR_UP);
      if (t.posy < m - 2 && (type ^ w[t.posx][t.posy + 2]) &&
        (norm || !(t.posx === n - 2 && t.posy + 2 === m - 2))) moves.push(DIR_DOWN);
      if (t.posx > 1 && (type ^ w[t.posx - 2][t.posy]) &&
        (norm || !(t.posx === n && t.posy === m - 2))) moves.push(DIR_LEFT);
      if (t.posx < n - 2 && (type ^ w[t.posx + 2][t.posy]) &&
        (norm || !(t.posx + 2 === n - 2 && t.posy === m - 2))) moves.push(DIR_RIGHT);
    }
    return moves;
  }

  _completeTasks(generate) {
    let tmp = this._first;
    while (tmp) {
      const after = tmp.next; // capture before any deletion
      if (generate) {
        if (tmp.posx === this.n - 2 && tmp.posy === this.m - 2) {
          this._delTask(tmp);
        } else {
          const moves = this._getMoves(tmp, TYPE_NORMAL);
          if (moves.length) {
            for (let i = 0; i < moves.length - 1; i++) {
              if (Math.random() < this.q) this._addTask(tmp.posx, tmp.posy, DIR_INIT);
            }
            if (tmp.dir === DIR_INIT || !moves.includes(tmp.dir) || Math.random() < this.p) {
              tmp.dir = moves[(Math.random() * moves.length) | 0];
            }
            this._move(tmp);
          } else {
            this._delTask(tmp);
          }
        }
      } else {
        const moves = this._getMoves(tmp, TYPE_BACKWARD);
        if (moves.length) for (const dir of moves) this._addPath(tmp, dir);
        else this._delTask(tmp);
      }
      tmp = after;
    }
  }

  _tryConnect(t) {
    const moves = this._getMoves(t, TYPE_REVERSE);
    if (moves.length) {
      t.dir = moves[(Math.random() * moves.length) | 0];
      this._move(t);
    }
  }

  _notFull() {
    const w = this.wall, n = this.n, m = this.m;
    for (let i = 1; i < n; i += 2) {
      for (let j = 1; j < m; j += 2) {
        if (w[i][j]) {
          w[i][j] = 0;
          this._tryConnect(this._addTask(i, j, DIR_INIT));
          return true;
        }
      }
    }
    return false;
  }

  _addPath(t, dir) {
    const next = this.next;
    const here = { x: t.posx, y: t.posy };
    switch (dir) {
      case DIR_UP: next[t.posx][t.posy - 1] = here; this._addTask(t.posx, t.posy - 1, DIR_INIT); break;
      case DIR_DOWN: next[t.posx][t.posy + 1] = here; this._addTask(t.posx, t.posy + 1, DIR_INIT); break;
      case DIR_LEFT: next[t.posx - 1][t.posy] = here; this._addTask(t.posx - 1, t.posy, DIR_INIT); break;
      case DIR_RIGHT: next[t.posx + 1][t.posy] = here; this._addTask(t.posx + 1, t.posy, DIR_INIT); break;
    }
  }

  _computePaths() {
    const n = this.n, m = this.m, next = this.next;
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) next[i][j] = null;
    next[n - 2][m - 2] = { x: n - 2, y: m - 1 }; // seed: room before the exit → exit
    this._first = null;
    this._addTask(n - 2, m - 2, DIR_INIT);
    while (this._first) this._completeTasks(false);
    this.wall[n - 2][m - 1] = 0; // open the exit
  }

  // Solution path as a list of cells, from the entrance room out through the exit.
  solutionPath() {
    const path = [];
    let cell = { x: 1, y: 1 };
    const seen = new Set();
    while (cell) {
      const key = cell.x * 10000 + cell.y;
      if (seen.has(key)) break;
      seen.add(key);
      path.push(cell);
      cell = this.next[cell.x][cell.y];
    }
    return path;
  }
}
