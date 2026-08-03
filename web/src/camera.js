import * as THREE from 'three';

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/**
 * Orbiting follow camera.
 *
 * The look-at point is smoothed rather than the camera position, which keeps the
 * subject rock-steady in frame while the rig itself still eases. Terrain
 * intrusion is resolved by shortening the boom rather than moving it sideways.
 */
export class ThirdPersonCamera {
  constructor(camera, field) {
    this.camera = camera;
    this.field = field;

    this.yaw = Math.PI;
    this.pitch = 0.30;
    // The character is only ~1.2 units tall, so the boom has to be short for it
    // to read at all.
    this.distance = 4.2;
    this.desiredDistance = 4.2;
    this.minDistance = 1.5;
    this.maxDistance = 15;

    this.pivot = new THREE.Vector3();
    this.smoothedPivot = new THREE.Vector3();
    this.initialised = false;

    // Soft auto-follow: after a moment without manual look input the rig drifts
    // back behind the character, so one-handed touch play does not require
    // constant steering.
    this.autoAlign = true;
    this.idleLookTime = 0;
    this.autoAlignDelay = 1.1;
    this.autoAlignRate = 1.3;

    this._offset = new THREE.Vector3();
    this._probe = new THREE.Vector3();
    this._desired = new THREE.Vector3();
  }

  /** Horizontal forward/right basis implied by the current yaw. */
  basis(forward, right) {
    forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    right.set(-forward.z, 0, forward.x);
    return { forward, right };
  }

  /**
   * @param {number} [travelHeading] direction the subject is moving in, if any.
   *   Supplying it lets the rig ease itself back behind them.
   */
  update(dt, focus, look, zoom, travelHeading = null) {
    this.yaw -= look.dx;
    this.pitch = clamp(this.pitch + look.dy, -0.38, 1.18);
    this.desiredDistance = clamp(this.desiredDistance + zoom, this.minDistance, this.maxDistance);

    if (look.dx !== 0 || look.dy !== 0) this.idleLookTime = 0;
    else this.idleLookTime += dt;

    if (this.autoAlign && travelHeading !== null && this.idleLookTime > this.autoAlignDelay) {
      // The rig sits opposite the subject's heading, so the target yaw is the
      // heading turned half a turn.
      const target = travelHeading + Math.PI;
      let delta = target - this.yaw;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      this.yaw += delta * (1 - Math.exp(-this.autoAlignRate * dt));
    }
    this.distance += (this.desiredDistance - this.distance) * (1 - Math.exp(-dt * 11));

    this.pivot.set(focus.x, focus.y + 0.82, focus.z);
    if (!this.initialised) {
      this.smoothedPivot.copy(this.pivot);
      this.initialised = true;
    }
    this.smoothedPivot.lerp(this.pivot, 1 - Math.exp(-dt * 15));

    const cp = Math.cos(this.pitch);
    this._offset.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);

    // Walk the boom outwards and stop early if the ground gets in the way.
    let allowed = this.distance;
    const STEPS = 10;
    for (let i = 1; i <= STEPS; i++) {
      const t = (i / STEPS) * this.distance;
      this._probe.copy(this.smoothedPivot).addScaledVector(this._offset, t);
      const ground = this.field.heightAt(this._probe.x, this._probe.z) + 0.65;
      if (this._probe.y < ground) {
        allowed = Math.max(this.minDistance * 0.7, t - this.distance / STEPS);
        break;
      }
    }

    this._desired.copy(this.smoothedPivot).addScaledVector(this._offset, allowed);
    const floor = this.field.heightAt(this._desired.x, this._desired.z) + 0.55;
    if (this._desired.y < floor) this._desired.y = floor;

    this.camera.position.copy(this._desired);
    this.camera.lookAt(this.smoothedPivot);
  }
}

/** Detached fly camera, for looking at the world without the character in it. */
export class FreeCamera {
  constructor(camera, field) {
    this.camera = camera;
    this.field = field;
    this.yaw = Math.PI;
    this.pitch = -0.1;
    this.speed = 18;
    this._dir = new THREE.Vector3();
    this._right = new THREE.Vector3();
  }

  adoptFrom(camera, yaw, pitch) {
    this.camera.position.copy(camera.position);
    this.yaw = yaw + Math.PI;
    this.pitch = -pitch;
  }

  update(dt, input, look) {
    this.yaw -= look.dx;
    this.pitch = clamp(this.pitch - look.dy, -1.45, 1.45);

    this._dir.set(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    ).normalize();
    this._right.set(this._dir.z, 0, -this._dir.x).normalize();

    const boost = input.sprint ? 3.4 : 1;
    const step = this.speed * boost * dt;
    this.camera.position.addScaledVector(this._dir, input.axis.forward * step);
    this.camera.position.addScaledVector(this._right, -input.axis.right * step);
    if (input.keys.has('KeyE')) this.camera.position.y += step;
    if (input.keys.has('KeyQ')) this.camera.position.y -= step;

    const floor = this.field.heightAt(this.camera.position.x, this.camera.position.z) + 1.2;
    if (this.camera.position.y < floor) this.camera.position.y = floor;

    this.camera.lookAt(
      this.camera.position.x + this._dir.x,
      this.camera.position.y + this._dir.y,
      this.camera.position.z + this._dir.z,
    );
  }
}
